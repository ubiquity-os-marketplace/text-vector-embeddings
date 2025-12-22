import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { Context } from "../types/context";
import { Database } from "../types/database";
import { Env } from "../types/env";
import { getEmbeddingQueueSettings, sleep } from "../utils/embedding-queue";

type QueueLogger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

type QueueClients = {
  supabase: SupabaseClient<Database>;
  voyage: VoyageAIClient;
};

type QueueStats = {
  issuesProcessed: number;
  commentsProcessed: number;
  stoppedEarly: boolean;
};

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("rate limit");
}

async function createEmbeddingWithRetry(
  embedder: VoyageEmbedding,
  text: string,
  maxRetries: number,
  delayMs: number,
  logger: QueueLogger
): Promise<number[] | null> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await embedder.createEmbedding(text);
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error;
      }
      logger.warn("Voyage rate limit hit while creating embedding.", { attempt: attempt + 1 });
      if (attempt >= maxRetries) {
        return null;
      }
      await sleep(delayMs);
      attempt += 1;
    }
  }
  return null;
}

async function processPendingRows(params: {
  table: "issues" | "issue_comments";
  supabase: SupabaseClient<Database>;
  embedder: VoyageEmbedding;
  settings: ReturnType<typeof getEmbeddingQueueSettings>;
  logger: QueueLogger;
}): Promise<{ processed: number; stoppedEarly: boolean }> {
  const { table, supabase, embedder, settings, logger } = params;
  const { data, error } = await supabase
    .from(table)
    .select("id, markdown, modified_at")
    .is("embedding", null)
    .is("deleted_at", null)
    .not("markdown", "is", null)
    .order("modified_at", { ascending: true })
    .limit(settings.batchSize);

  if (error) {
    logger.error("Failed to load pending embeddings.", { table, error });
    return { processed: 0, stoppedEarly: false };
  }

  if (!data || data.length === 0) {
    return { processed: 0, stoppedEarly: false };
  }

  let processed = 0;
  for (const row of data) {
    const markdown = typeof row.markdown === "string" ? row.markdown : "";
    const cleaned = stripHtmlComments(markdown).trim();
    if (!cleaned) {
      logger.warn("Skipping empty markdown embedding.", { table, id: row.id });
      continue;
    }

    const embedding = await createEmbeddingWithRetry(embedder, cleaned, settings.maxRetries, settings.delayMs, logger);
    if (!embedding) {
      return { processed, stoppedEarly: true };
    }

    const { error: updateError } = await supabase.from(table).update({ embedding, modified_at: new Date().toISOString() }).eq("id", row.id);

    if (updateError) {
      logger.error("Failed to update embedding.", { table, id: row.id, updateError });
      continue;
    }

    processed += 1;
    await sleep(settings.delayMs);
  }

  return { processed, stoppedEarly: false };
}

export async function processPendingEmbeddings(params: { env: Env; clients: QueueClients; logger: QueueLogger }): Promise<QueueStats> {
  const { env, clients, logger } = params;
  const settings = getEmbeddingQueueSettings(env);

  if (!settings.enabled) {
    logger.debug("Embedding queue disabled; skipping pending embeddings.");
    return { issuesProcessed: 0, commentsProcessed: 0, stoppedEarly: false };
  }

  const embedder = new VoyageEmbedding(clients.voyage, { logger } as unknown as Context);

  const issueResult = await processPendingRows({
    table: "issues",
    supabase: clients.supabase,
    embedder,
    settings,
    logger,
  });

  const commentResult = await processPendingRows({
    table: "issue_comments",
    supabase: clients.supabase,
    embedder,
    settings,
    logger,
  });

  return {
    issuesProcessed: issueResult.processed,
    commentsProcessed: commentResult.processed,
    stoppedEarly: issueResult.stoppedEarly || commentResult.stoppedEarly,
  };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const CODE_FENCE_REGEX = /^\s*(```|~~~)/;

function stripHtmlComments(markdown: string): string {
  if (!markdown) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  let isInFence = false;
  let fenceToken = "";
  let buffer: string[] = [];
  const output: string[] = [];

  const flushBuffer = (preserveComments: boolean) => {
    if (buffer.length === 0) {
      return;
    }
    const chunk = buffer.join("\n");
    output.push(preserveComments ? chunk : chunk.replace(HTML_COMMENT_REGEX, ""));
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(CODE_FENCE_REGEX);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!isInFence) {
        flushBuffer(false);
        isInFence = true;
        fenceToken = fence;
        buffer.push(line);
      } else if (fence === fenceToken) {
        buffer.push(line);
        flushBuffer(true);
        isInFence = false;
        fenceToken = "";
      } else {
        buffer.push(line);
      }
      continue;
    }
    buffer.push(line);
  }

  flushBuffer(isInFence);

  return output.join("\n");
}
