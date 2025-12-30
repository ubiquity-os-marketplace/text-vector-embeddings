import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { DocumentType } from "../types/document";
import { Context } from "../types/context";
import { Database } from "../types/database";
import { Env } from "../types/env";
import { getEmbeddingQueueSettings, sleep } from "../utils/embedding-queue";
import { cleanMarkdown, isTooShort, MIN_COMMENT_MARKDOWN_LENGTH, MIN_ISSUE_MARKDOWN_LENGTH } from "../utils/embedding-content";
import { isCommandLikeContent } from "../utils/markdown-comments";

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

function getNestedNumber(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "number" ? current : null;
}

function isReviewCommentThreadRoot(payload: unknown): boolean {
  const parentId = getNestedNumber(payload, ["comment", "in_reply_to_id"]);
  return parentId === null;
}

function getAuthorType(payload: unknown, docType: DocumentType): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (docType === "issue" || docType === "pull_request") {
    return (
      getNestedString(payload, ["issue", "user", "type"]) ??
      getNestedString(payload, ["pull_request", "user", "type"]) ??
      getNestedString(payload, ["sender", "type"])
    );
  }
  if (docType === "pull_request_review") {
    return getNestedString(payload, ["review", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
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
  docTypes: DocumentType[];
  label: "issues" | "comments";
  supabase: SupabaseClient<Database>;
  embedder: VoyageEmbedding;
  settings: ReturnType<typeof getEmbeddingQueueSettings>;
  logger: QueueLogger;
}): Promise<{ processed: number; stoppedEarly: boolean }> {
  const { docTypes, label, supabase, embedder, settings, logger } = params;
  const { data, error } = await supabase
    .from("documents")
    .select("id, markdown, modified_at, payload, doc_type")
    .in("doc_type", docTypes)
    .is("embedding", null)
    .is("deleted_at", null)
    .not("markdown", "is", null)
    .order("modified_at", { ascending: true })
    .limit(settings.batchSize);

  if (error) {
    logger.error("Failed to load pending embeddings.", { label, error });
    return { processed: 0, stoppedEarly: false };
  }

  if (!data || data.length === 0) {
    return { processed: 0, stoppedEarly: false };
  }

  let processed = 0;
  for (const row of data) {
    const docType = row.doc_type as DocumentType;
    const authorType = getAuthorType(row.payload, docType);
    if (authorType && authorType !== "User") {
      const isBotRootReviewAllowed = docType === "review_comment" && isReviewCommentThreadRoot(row.payload);
      if (!isBotRootReviewAllowed) {
        logger.info("Skipping embedding for non-human author.", { label, id: row.id, authorType, docType });
        const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
        if (updateError) {
          logger.error("Failed to clear markdown for non-human author.", { label, id: row.id, updateError });
        }
        continue;
      }
      logger.info("Allowing bot-authored root review comment for embedding.", { label, id: row.id, authorType, docType });
    }

    const cleaned = cleanMarkdown(typeof row.markdown === "string" ? row.markdown : null);
    const isIssueDoc = docType === "issue" || docType === "pull_request";
    const minLength = isIssueDoc ? MIN_ISSUE_MARKDOWN_LENGTH : MIN_COMMENT_MARKDOWN_LENGTH;
    if ((docType === "issue_comment" || docType === "review_comment" || docType === "pull_request_review") && isCommandLikeContent(cleaned)) {
      logger.info("Skipping embedding for command-like comment.", { label, id: row.id, docType });
      const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for command-like comment.", { label, id: row.id, updateError });
      }
      continue;
    }
    if (!cleaned) {
      logger.warn("Skipping empty markdown embedding.", { label, id: row.id, docType });
      const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for empty content.", { label, id: row.id, updateError });
      }
      continue;
    }
    if (isTooShort(cleaned, minLength)) {
      logger.info("Skipping embedding for short content.", { label, id: row.id, length: cleaned.length, minLength, docType });
      const { error: updateError } = await supabase.from("documents").update({ markdown: null, modified_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for short content.", { label, id: row.id, updateError });
      }
      continue;
    }

    const embedding = await createEmbeddingWithRetry(embedder, cleaned, settings.maxRetries, settings.delayMs, logger);
    if (!embedding) {
      return { processed, stoppedEarly: true };
    }

    const { error: updateError } = await supabase.from("documents").update({ embedding, modified_at: new Date().toISOString() }).eq("id", row.id);

    if (updateError) {
      logger.error("Failed to update embedding.", { label, id: row.id, updateError });
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
    docTypes: ["issue", "pull_request"],
    label: "issues",
    supabase: clients.supabase,
    embedder,
    settings,
    logger,
  });

  const commentResult = await processPendingRows({
    docTypes: ["issue_comment", "review_comment", "pull_request_review"],
    label: "comments",
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
