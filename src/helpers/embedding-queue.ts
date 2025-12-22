import { VOYAGE_EMBEDDING_MODEL } from "../adapters/voyage/helpers/embedding";
import { Context } from "../types/index";
import { stripHtmlComments } from "../utils/markdown-comments";

const QUEUE_PREFIX = "embedding-queue";

export type EmbeddingQueueJob = Readonly<{
  table: "issues" | "issue_comments";
  id: string;
  attempt: number;
}>;

type QueueEntry = Readonly<{ key: Deno.KvKey; job: EmbeddingQueueJob; runAt: number }>;

type EmbeddingRow = Readonly<{
  markdown?: string | null;
  plaintext?: string | null;
  deleted_at?: string | null;
  embedding_status?: string | null;
  embedding?: unknown;
}> | null;

type KvLike = Readonly<{
  list: (selector: { prefix: Deno.KvKey }) => AsyncIterable<Deno.KvEntry<EmbeddingQueueJob>>;
  set: (key: Deno.KvKey, value: EmbeddingQueueJob) => Promise<unknown>;
  delete: (key: Deno.KvKey) => Promise<unknown>;
}>;

let kvPromise: Promise<KvLike | null> | null = null;

function resolveEmbeddingMode(context: Context): "sync" | "async" {
  return context.config?.embeddingMode === "async" ? "async" : "sync";
}

export function shouldDeferEmbedding(context: Context, isPrivate: boolean): boolean {
  return resolveEmbeddingMode(context) === "async" && !isPrivate;
}

function parseRunAtFromKey(key: Deno.KvKey): number {
  const value = key[1];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getEmbeddingSource(row: EmbeddingRow): string | null {
  if (!row) return null;
  const markdown = typeof row.markdown === "string" ? row.markdown.trim() : "";
  if (markdown) return stripHtmlComments(markdown);
  const plaintext = typeof row.plaintext === "string" ? row.plaintext.trim() : "";
  return plaintext || null;
}

function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status === 429) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("rate limit") || message.includes("429");
}

function buildQueueKey(runAt: number): Deno.KvKey {
  return [QUEUE_PREFIX, runAt, crypto.randomUUID()];
}

async function getKv(): Promise<KvLike | null> {
  if (kvPromise) return kvPromise;
  kvPromise = (async () => {
    const deno = (globalThis as unknown as { Deno?: { openKv?: (path?: string) => Promise<unknown> } }).Deno;
    if (!deno || typeof deno.openKv !== "function") return null;
    try {
      const kv = await deno.openKv(process.env.DENO_KV_URL);
      if (!kv || typeof (kv as KvLike).list !== "function") return null;
      return kv as KvLike;
    } catch {
      return null;
    }
  })();
  return kvPromise;
}

async function listReadyJobs(kv: KvLike, limit: number, nowMs: number): Promise<QueueEntry[]> {
  const entries: QueueEntry[] = [];
  for await (const entry of kv.list({ prefix: [QUEUE_PREFIX] })) {
    const runAt = parseRunAtFromKey(entry.key);
    if (!runAt || runAt > nowMs) break;
    entries.push({ key: entry.key, job: entry.value, runAt });
    if (entries.length >= limit) break;
  }
  return entries;
}

export async function enqueueEmbeddingJob(context: Context, job: Omit<EmbeddingQueueJob, "attempt"> & { attempt?: number }, delayMs = 0) {
  const kv = await getKv();
  if (!kv) {
    context.logger.debug("Deno KV not available; skipping embedding queue enqueue");
    return;
  }
  const runAt = Date.now() + Math.max(0, delayMs);
  const key = buildQueueKey(runAt);
  await kv.set(key, {
    table: job.table,
    id: job.id,
    attempt: typeof job.attempt === "number" && Number.isFinite(job.attempt) ? Math.max(0, job.attempt) : 0,
  });
}

export async function processEmbeddingQueue(context: Context) {
  if (resolveEmbeddingMode(context) !== "async") return;

  const kv = await getKv();
  if (!kv) {
    context.logger.debug("Deno KV not available; skipping embedding queue processing");
    return;
  }

  const maxPerRun = typeof context.config?.embeddingQueueMaxPerRun === "number" ? Math.max(1, context.config.embeddingQueueMaxPerRun) : 3;
  const baseDelaySeconds = typeof context.config?.embeddingQueueDelaySeconds === "number" ? Math.max(5, context.config.embeddingQueueDelaySeconds) : 60;
  const maxAttempts = typeof context.config?.embeddingQueueMaxAttempts === "number" ? Math.max(1, context.config.embeddingQueueMaxAttempts) : 6;
  const nowMs = Date.now();

  const entries = await listReadyJobs(kv, maxPerRun, nowMs);
  if (entries.length === 0) return;

  for (const entry of entries) {
    await kv.delete(entry.key);
    const job = entry.job;
    try {
      if (job.table === "issues") {
        const row = (await context.adapters.supabase.issue.getIssue(job.id))?.[0] ?? null;
        if (row?.deleted_at) continue;
        if (row?.embedding_status === "ready" && row.embedding) continue;
        const source = getEmbeddingSource(row);
        if (!source) {
          await context.adapters.supabase.issue.markEmbeddingFailed(job.id);
          continue;
        }
        const embedding = await context.adapters.voyage.embedding.createEmbedding(source);
        await context.adapters.supabase.issue.updateEmbedding(job.id, embedding, VOYAGE_EMBEDDING_MODEL);
      } else {
        const row = (await context.adapters.supabase.comment.getComment(job.id))?.[0] ?? null;
        if (row?.deleted_at) continue;
        if (row?.embedding_status === "ready" && row.embedding) continue;
        const source = getEmbeddingSource(row);
        if (!source) {
          await context.adapters.supabase.comment.markEmbeddingFailed(job.id);
          continue;
        }
        const embedding = await context.adapters.voyage.embedding.createEmbedding(source);
        await context.adapters.supabase.comment.updateEmbedding(job.id, embedding, VOYAGE_EMBEDDING_MODEL);
      }
    } catch (error) {
      if (isRateLimitError(error) && job.attempt < maxAttempts) {
        const delayMs = baseDelaySeconds * 1000 * Math.pow(2, Math.max(0, job.attempt));
        await enqueueEmbeddingJob(context, { ...job, attempt: job.attempt + 1 }, delayMs);
        continue;
      }
      context.logger.error("Embedding job failed", { job, error });
      if (job.table === "issues") {
        await context.adapters.supabase.issue.markEmbeddingFailed(job.id);
      } else {
        await context.adapters.supabase.comment.markEmbeddingFailed(job.id);
      }
    }
  }
}
