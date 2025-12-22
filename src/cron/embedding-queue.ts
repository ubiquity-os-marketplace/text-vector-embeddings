import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { Context } from "../types/context";
import { Database } from "../types/database";
import { Env } from "../types/env";
import { getEmbeddingQueueSettings, sleep } from "../utils/embedding-queue";
import { isCommandLikeContent, stripHtmlComments } from "../utils/markdown-comments";

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

type JsonRecord = Record<string, unknown>;

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("rate limit");
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "string" ? current : null;
}

function getAuthorType(payload: unknown, table: "issues" | "issue_comments"): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (table === "issues") {
    return (
      getNestedString(payload, ["issue", "user", "type"]) ??
      getNestedString(payload, ["pull_request", "user", "type"]) ??
      getNestedString(payload, ["sender", "type"])
    );
  }

  return getNestedString(payload, ["comment", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
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
    .select("id, markdown, modified_at, payload")
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
    const authorType = getAuthorType(row.payload, table);
    if (authorType && authorType !== "User") {
      logger.info("Skipping embedding for non-human author.", { table, id: row.id, authorType });
      const { error: updateError } = await supabase.from(table).update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for non-human author.", { table, id: row.id, updateError });
      }
      continue;
    }

    const markdown = typeof row.markdown === "string" ? row.markdown : "";
    const cleaned = stripHtmlComments(markdown).trim();
    if (table === "issue_comments" && isCommandLikeContent(cleaned)) {
      logger.info("Skipping embedding for command-like comment.", { table, id: row.id });
      const { error: updateError } = await supabase.from(table).update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for command-like comment.", { table, id: row.id, updateError });
      }
      continue;
    }
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
