import { SupabaseClient } from "@supabase/supabase-js";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import dotenv from "dotenv";
import { processPendingEmbeddings } from "../src/cron/embedding-queue";
import { createReprocessClients, decodeEnv } from "../src/cron/reprocess";
import { Database } from "../src/types/database";
import type { Context } from "../src/types/index";
import { getEmbeddingQueueSettings, sleep } from "../src/utils/embedding-queue";

type CliOptions = {
  envFile?: string;
  once: boolean;
  maxEmpty: number;
  intervalMs: number;
  logLevel?: string;
  fixedDelay: boolean;
  autoBatch: boolean;
};

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/backfill-embeddings.ts [options]

Options:
  --env-file       Path to a .env file (optional).
  --once           Run a single pass and exit.
  --fixed-delay    Keep EMBEDDINGS_QUEUE_DELAY_MS constant (disable auto-tuning).
  --fixed-batch    Keep EMBEDDINGS_QUEUE_BATCH_SIZE constant (disable auto-tuning).
  --auto-batch     Enable batch size auto-tuning (default).
  --max-empty      Max consecutive empty passes before abort (default: 3).
  --interval-ms    Extra delay between passes (default: 0).
  --log-level      Override log level (default: env LOG_LEVEL or info).
  --help           Show this help.

Env:
  SUPABASE_URL, SUPABASE_KEY, VOYAGEAI_API_KEY
  EMBEDDINGS_QUEUE_* (optional)`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    once: false,
    maxEmpty: 3,
    intervalMs: 0,
    fixedDelay: false,
    autoBatch: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--env-file":
        options.envFile = argv[index + 1];
        index += 1;
        break;
      case "--once":
        options.once = true;
        break;
      case "--fixed-delay":
        options.fixedDelay = true;
        break;
      case "--fixed-batch":
        options.autoBatch = false;
        break;
      case "--auto-batch":
        options.autoBatch = true;
        break;
      case "--max-empty":
        {
          const parsed = Number(argv[index + 1]);
          if (Number.isFinite(parsed) && parsed >= 0) {
            options.maxEmpty = parsed;
          }
        }
        index += 1;
        break;
      case "--interval-ms":
        {
          const parsed = Number(argv[index + 1]);
          if (Number.isFinite(parsed) && parsed >= 0) {
            options.intervalMs = parsed;
          }
        }
        index += 1;
        break;
      case "--log-level":
        options.logLevel = argv[index + 1];
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return options;
}

const DELAY_STEP_MS = 250;

function clampDelay(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function quantizeUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function quantizeDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function nextDelayIncrease(current: number, min: number, max: number): number {
  return clampDelay(quantizeUp(current + DELAY_STEP_MS, DELAY_STEP_MS), min, max);
}

function nextDelayDecrease(current: number, min: number, max: number): number {
  return clampDelay(quantizeDown(current - DELAY_STEP_MS, DELAY_STEP_MS), min, max);
}

function isTokenLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const haystack = message.toLowerCase();
  return (
    (haystack.includes("token") && (haystack.includes("limit") || haystack.includes("too many") || haystack.includes("maximum"))) ||
    haystack.includes("context length") ||
    haystack.includes("max input") ||
    haystack.includes("input too long") ||
    haystack.includes("request too large") ||
    haystack.includes("payload too large")
  );
}

async function getPendingCount(supabase: SupabaseClient<Database>): Promise<number> {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)
    .is("deleted_at", null)
    .not("markdown", "is", null);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  dotenv.config();
  if (options.envFile) {
    dotenv.config({ path: options.envFile, override: true });
  }
  if (!process.env.SUPABASE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    process.env.SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  const env = decodeEnv(process.env);
  const logger = new Logs((options.logLevel as LogLevel) ?? (process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO) as unknown as Context["logger"];
  const clients = createReprocessClients(env);
  const baseSettings = getEmbeddingQueueSettings(env);
  const baseBatchSize = Math.max(1, baseSettings.batchSize);
  const baseDelayMs = Math.max(DELAY_STEP_MS, baseSettings.delayMs);

  let batchSize = baseBatchSize;
  let batchFloor = 1;
  let batchCeil = baseBatchSize;
  let hasBatchFailure = false;

  let delayMs = quantizeUp(baseDelayMs, DELAY_STEP_MS);
  const delayMin = baseDelayMs;
  const delayMax = Math.max(delayMin, 60_000);
  let delayGood: number | null = null;
  let delayBad: number | null = null;

  let pass = 0;
  let totalProcessed = 0;
  let emptyPasses = 0;

  while (true) {
    env.EMBEDDINGS_QUEUE_BATCH_SIZE = String(batchSize);
    env.EMBEDDINGS_QUEUE_DELAY_MS = String(delayMs);

    const settings = getEmbeddingQueueSettings(env);

    const pendingBefore = await getPendingCount(clients.supabase);
    if (pendingBefore === 0) {
      logger.ok("Backfill complete.", { passes: pass, totalProcessed });
      break;
    }

    pass += 1;
    logger.info("Backfill pass starting.", {
      pass,
      pending: pendingBefore,
      batchSize: settings.batchSize,
      delayMs: settings.delayMs,
      concurrency: settings.concurrency,
      batchFloor,
      batchCeil,
    });

    let isTokenLimited = false;
    let result: Awaited<ReturnType<typeof processPendingEmbeddings>> = {
      issuesProcessed: 0,
      commentsProcessed: 0,
      stoppedEarly: false,
    };

    try {
      result = await processPendingEmbeddings({ env, clients, logger });
    } catch (error) {
      if (isTokenLimitError(error)) {
        isTokenLimited = true;
      } else {
        throw error;
      }
    }

    const processed = result.issuesProcessed + result.commentsProcessed;
    totalProcessed += processed;

    const pendingAfter = await getPendingCount(clients.supabase);

    let nextBatchSize = batchSize;
    let nextDelayMs = delayMs;

    if (isTokenLimited) {
      emptyPasses = 0;
      if (!options.autoBatch) {
        logger.error("Token limit hit while auto-batch is disabled. Reduce EMBEDDINGS_QUEUE_BATCH_SIZE or pass --auto-batch.", {
          batchSize,
        });
        process.exit(1);
      }
      if (batchSize <= 1) {
        logger.error("Token limit hit at batch size 1; cannot auto-recover.", { batchSize });
        process.exit(1);
      }
      hasBatchFailure = true;
      batchCeil = Math.max(batchFloor, batchSize - 1);
      nextBatchSize = Math.max(batchFloor, Math.floor((batchFloor + batchCeil) / 2));
      if (nextBatchSize >= batchSize) {
        logger.error("Token limit hit but batch size cannot shrink further. Lower EMBEDDINGS_QUEUE_BATCH_SIZE.", {
          batchSize,
          batchFloor,
          batchCeil,
        });
        process.exit(1);
      }
    } else if (result.stoppedEarly) {
      emptyPasses = 0;
      if (!options.fixedDelay) {
        delayBad = delayMs;
        if (delayGood !== null && delayGood < delayBad) {
          const candidate = quantizeUp((delayGood + delayBad) / 2, DELAY_STEP_MS);
          nextDelayMs = clampDelay(Math.max(candidate, nextDelayIncrease(delayGood, delayMin, delayMax)), delayMin, delayMax);
        } else if (delayGood === null) {
          const candidate = quantizeUp(delayMs * 2, DELAY_STEP_MS);
          nextDelayMs = clampDelay(candidate === delayMs ? nextDelayIncrease(delayMs, delayMin, delayMax) : candidate, delayMin, delayMax);
        } else {
          nextDelayMs = nextDelayIncrease(delayMs, delayMin, delayMax);
        }
      }
    }

    if (!result.stoppedEarly && !isTokenLimited) {
      if (processed === 0) {
        emptyPasses += 1;
        if (emptyPasses >= options.maxEmpty) {
          logger.error("No progress detected; aborting to avoid an infinite loop.", {
            pendingAfter,
            emptyPasses,
          });
          process.exit(1);
        }
      } else {
        emptyPasses = 0;
      }

      if (processed > 0) {
        if (options.autoBatch) {
          if (hasBatchFailure && batchFloor < batchCeil) {
            batchFloor = Math.max(batchFloor, batchSize);
            nextBatchSize = Math.max(batchFloor, Math.floor((batchFloor + batchCeil + 1) / 2));
          } else if (!hasBatchFailure) {
            nextBatchSize = batchCeil;
          }
        }

        if (!options.fixedDelay) {
          delayGood = delayMs;
          if (delayBad !== null && delayGood < delayBad) {
            const candidate = quantizeDown((delayGood + delayBad) / 2, DELAY_STEP_MS);
            nextDelayMs = clampDelay(Math.min(candidate, nextDelayDecrease(delayBad, delayMin, delayMax)), delayMin, delayMax);
          } else if (delayMs > delayMin) {
            nextDelayMs = nextDelayDecrease(delayMs, delayMin, delayMax);
          }
        }
      }
    }

    logger.ok("Backfill pass finished.", {
      pass,
      processedIssues: result.issuesProcessed,
      processedComments: result.commentsProcessed,
      processed,
      stoppedEarly: result.stoppedEarly,
      tokenLimited: isTokenLimited,
      pendingAfter,
      totalProcessed,
      nextBatchSize,
      nextDelayMs,
    });

    batchSize = nextBatchSize;
    delayMs = nextDelayMs;

    if (options.once) {
      break;
    }

    if (result.stoppedEarly) {
      await sleep(delayMs);
      continue;
    }

    if (options.intervalMs > 0) {
      await sleep(options.intervalMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
