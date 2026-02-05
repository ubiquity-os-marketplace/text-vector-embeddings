import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding, VOYAGE_EMBEDDING_DIM, VOYAGE_EMBEDDING_MODEL } from "../adapters/voyage/helpers/embedding";
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

type QueueLabel = "issues" | "comments" | "documents";

type PendingRow = {
  id: string;
  markdown: string | null;
  modified_at: string | null;
  payload: unknown;
  doc_type: DocumentType;
};

type PreparedEntry = { row: PendingRow; embeddingSource: string };

type JsonRecord = Record<string, unknown>;
type EmbedRetryResult = { embeddings: number[][] | null; rateLimited: boolean; error: unknown | null };

const MAX_RATE_LIMIT_DELAY_MS = 60_000;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 2;
const MIN_TPM_LIMIT = 1_000;
const MIN_RPM_LIMIT = 1;
const TPM_SAFETY_RATIO = 0.8;
const RPM_WINDOW_MS = 60_000;

let observedTpmLimit: number | null = null;
let observedRpmLimit: number | null = null;
let tpmWindowStartMs: number | null = null;
let tpmUsedTokens = 0;
const rpmHistory: number[] = [];

function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode = getStatusCode(error);
    if (statusCode === 429) {
      return true;
    }
    const body = (error as JsonRecord).body;
    const bodyMessage =
      getNestedString(body, ["error", "message"]) ??
      getNestedString(body, ["message"]) ??
      getNestedString(body, ["error", "type"]) ??
      getNestedString(body, ["error", "code"]);
    if (bodyMessage && bodyMessage.toLowerCase().includes("rate")) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("rate_limit");
}

function isTokenLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const body = (error as JsonRecord).body;
    const detail =
      getNestedString(body, ["detail"]) ??
      getNestedString(body, ["error", "message"]) ??
      getNestedString(body, ["message"]) ??
      getNestedString(body, ["error", "type"]) ??
      getNestedString(body, ["error", "code"]);
    if (detail) {
      const haystack = detail.toLowerCase();
      if (
        (haystack.includes("token") && (haystack.includes("limit") || haystack.includes("maximum") || haystack.includes("max"))) ||
        haystack.includes("tokens per submitted batch") ||
        haystack.includes("context length") ||
        haystack.includes("input too long") ||
        haystack.includes("request too large") ||
        haystack.includes("payload too large")
      ) {
        return true;
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const haystack = message.toLowerCase();
  return (
    (haystack.includes("token") && (haystack.includes("limit") || haystack.includes("maximum") || haystack.includes("max"))) ||
    haystack.includes("tokens per submitted batch") ||
    haystack.includes("context length") ||
    haystack.includes("input too long") ||
    haystack.includes("request too large") ||
    haystack.includes("payload too large")
  );
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  return (
    getNestedNumber(error, ["statusCode"]) ??
    getNestedNumber(error, ["status"]) ??
    getNestedNumber(error, ["httpStatus"]) ??
    getNestedNumber(error, ["response", "status"])
  );
}

function getErrorDetail(error: unknown): string | null {
  if (error && typeof error === "object") {
    const body = (error as JsonRecord).body;
    const detail = getNestedString(body, ["detail"]) ?? getNestedString(body, ["error", "message"]) ?? getNestedString(body, ["message"]);
    if (detail) {
      return detail;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return null;
}

function extractTpmLimit(detail: string | null): number | null {
  if (!detail) {
    return null;
  }
  const normalized = detail.replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(k)?\s*tpm/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const multiplier = match[2] ? 1000 : 1;
  const limit = Math.round(value * multiplier);
  return limit >= MIN_TPM_LIMIT ? limit : null;
}

function extractRpmLimit(detail: string | null): number | null {
  if (!detail) {
    return null;
  }
  const normalized = detail.replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*rpm/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const limit = Math.round(value);
  return limit >= MIN_RPM_LIMIT ? limit : null;
}

function safeTpmLimit(value: number | null): number | null {
  if (!value || value <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(value * TPM_SAFETY_RATIO));
}

function getRequestTokenBudget(): number | null {
  if (!observedTpmLimit || observedTpmLimit <= 0) {
    return null;
  }
  const safeLimit = safeTpmLimit(observedTpmLimit) ?? observedTpmLimit;
  if (observedRpmLimit && observedRpmLimit > 1) {
    return Math.max(1, Math.floor(safeLimit / observedRpmLimit));
  }
  return safeLimit;
}

function rpmIntervalMs(limit: number): number {
  return Math.ceil(RPM_WINDOW_MS / Math.max(1, limit));
}

function pruneRpmHistory(nowMs: number): void {
  while (rpmHistory.length > 0 && nowMs - rpmHistory[0] >= RPM_WINDOW_MS) {
    rpmHistory.shift();
  }
}

function recordRpmAttempt(timestampMs: number): void {
  rpmHistory.push(timestampMs);
  pruneRpmHistory(timestampMs);
}

async function throttleRpm(logger: QueueLogger, context: { label?: QueueLabel; batchSize?: number }): Promise<void> {
  if (!observedRpmLimit || observedRpmLimit <= 0) {
    return;
  }
  let nowMs = Date.now();
  pruneRpmHistory(nowMs);
  while (rpmHistory.length >= observedRpmLimit) {
    const oldest = rpmHistory[0];
    if (!oldest) {
      break;
    }
    const waitMs = Math.max(0, oldest + RPM_WINDOW_MS - nowMs);
    if (waitMs === 0) {
      pruneRpmHistory(Date.now());
      continue;
    }
    logger.debug("Throttling to respect RPM limit.", {
      ...context,
      rpmLimit: observedRpmLimit,
      waitMs,
    });
    await sleep(waitMs);
    nowMs = Date.now();
    pruneRpmHistory(nowMs);
  }
}

async function throttleTpm(logger: QueueLogger, estimatedTokens: number, context: { label?: QueueLabel; batchSize?: number }): Promise<void> {
  if (!observedTpmLimit || observedTpmLimit <= 0) {
    return;
  }
  const now = Date.now();
  if (tpmWindowStartMs === null || now - tpmWindowStartMs >= 60_000) {
    tpmWindowStartMs = now;
    tpmUsedTokens = 0;
  }

  if (estimatedTokens > observedTpmLimit) {
    logger.warn("Estimated tokens exceed TPM limit for single request.", {
      ...context,
      estimatedTokens,
      tpmLimit: observedTpmLimit,
    });
    return;
  }

  if (tpmUsedTokens + estimatedTokens > observedTpmLimit) {
    const waitMs = 60_000 - (now - tpmWindowStartMs);
    logger.debug("Throttling to respect TPM limit.", {
      ...context,
      estimatedTokens,
      tpmLimit: observedTpmLimit,
      waitMs,
    });
    await sleep(Math.max(0, waitMs));
    tpmWindowStartMs = Date.now();
    tpmUsedTokens = 0;
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function estimateTokensForTexts(texts: string[]): number {
  return texts.reduce((total, text) => total + estimateTokens(text), 0);
}

function estimateTokensForEntries(entries: PreparedEntry[]): number {
  return entries.reduce((total, entry) => total + estimateTokens(entry.embeddingSource), 0);
}

function splitEntriesByTokenBudget(
  entries: PreparedEntry[],
  maxTokens: number
): {
  chunks: PreparedEntry[][];
  oversized: Array<{ entry: PreparedEntry; estimatedTokens: number }>;
} {
  const chunks: PreparedEntry[][] = [];
  const oversized: Array<{ entry: PreparedEntry; estimatedTokens: number }> = [];
  let current: PreparedEntry[] = [];
  let currentTokens = 0;

  for (const entry of entries) {
    const tokens = estimateTokens(entry.embeddingSource);
    if (tokens > maxTokens) {
      oversized.push({ entry, estimatedTokens: tokens });
      continue;
    }
    if (currentTokens + tokens > maxTokens && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(entry);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return { chunks, oversized };
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

function getRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const body = (error as JsonRecord).body;
  const retryAfterSeconds =
    getNestedNumber(body, ["retry_after"]) ??
    getNestedNumber(body, ["error", "retry_after"]) ??
    getNestedNumber(body, ["retryAfter"]) ??
    getNestedNumber(body, ["error", "retryAfter"]);
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return null;
  }
  return Math.round(retryAfterSeconds * 1000);
}

function getRateLimitDelayMs(baseDelayMs: number, attempt: number, error: unknown): number {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  if (baseDelayMs <= 0) {
    return 0;
  }
  return Math.min(baseDelayMs * Math.pow(2, attempt), MAX_RATE_LIMIT_DELAY_MS);
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

async function createEmbeddingsWithRetry(
  embedder: VoyageEmbedding,
  texts: string[],
  maxRetries: number,
  delayMs: number,
  logger: QueueLogger
): Promise<EmbedRetryResult> {
  let attempt = 0;
  let lastRateLimitError: unknown | null = null;
  const estimatedTokens = estimateTokensForTexts(texts);
  while (attempt <= maxRetries) {
    try {
      const safeObserved = safeTpmLimit(observedTpmLimit);
      if (safeObserved && estimatedTokens > safeObserved) {
        return {
          embeddings: null,
          rateLimited: true,
          error: new Error(`Estimated tokens exceed TPM limit ${safeObserved} tpm.`),
        };
      }
      await throttleTpm(logger, estimatedTokens, { batchSize: texts.length });
      await throttleRpm(logger, { batchSize: texts.length });
      const requestTimestampMs = Date.now();
      recordRpmAttempt(requestTimestampMs);
      const embeddings = await embedder.createEmbeddings(texts);
      if (observedTpmLimit) {
        if (tpmWindowStartMs === null) {
          tpmWindowStartMs = requestTimestampMs;
        }
        tpmUsedTokens += estimatedTokens;
      }
      return { embeddings, rateLimited: false, error: null };
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error;
      }
      const backoffMs = getRateLimitDelayMs(delayMs, attempt, error);
      const retryAfterMs = getRetryAfterMs(error);
      const statusCode = getStatusCode(error);
      const detail = getErrorDetail(error);
      const tpmLimit = extractTpmLimit(detail);
      const rpmLimit = extractRpmLimit(detail);
      if (tpmLimit && (!observedTpmLimit || tpmLimit < observedTpmLimit)) {
        observedTpmLimit = tpmLimit;
      }
      if (rpmLimit && (!observedRpmLimit || rpmLimit < observedRpmLimit)) {
        observedRpmLimit = rpmLimit;
      }
      const safeLimit = safeTpmLimit(tpmLimit);
      if (safeLimit && estimatedTokens > safeLimit) {
        logger.warn("Estimated tokens exceed TPM limit; splitting batch.", {
          tpmLimit: safeLimit,
          estimatedTokens,
          batchSize: texts.length,
        });
        return { embeddings: null, rateLimited: true, error };
      }
      const rpmBackoffMs = rpmLimit ? rpmIntervalMs(rpmLimit) : 0;
      const waitMs = Math.max(backoffMs, rpmBackoffMs, retryAfterMs ?? 0);
      logger.warn("Voyage rate limit hit while creating embeddings batch.", {
        attempt: attempt + 1,
        backoffMs: waitMs,
        retryAfterMs,
        statusCode,
        detail,
        batchSize: texts.length,
      });
      lastRateLimitError = error;
      if (attempt >= maxRetries) {
        return { embeddings: null, rateLimited: true, error: lastRateLimitError };
      }
      await sleep(waitMs);
      attempt += 1;
    }
  }
  return { embeddings: null, rateLimited: false, error: lastRateLimitError };
}

async function preparePendingRow(params: {
  row: PendingRow;
  label: QueueLabel;
  supabase: SupabaseClient<Database>;
  logger: QueueLogger;
}): Promise<{ row: PendingRow; embeddingSource: string } | null> {
  const { row, label, supabase, logger } = params;
  const docType = row.doc_type as DocumentType;
  const authorType = getAuthorType(row.payload, docType);
  if (authorType && authorType !== "User") {
    const isBotRootReviewAllowed = docType === "review_comment" && isReviewCommentThreadRoot(row.payload);
    if (!isBotRootReviewAllowed) {
      logger.debug("Skipping embedding for non-human author.", { label, id: row.id, authorType, docType });
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("documents")
        .update({
          markdown: null,
          embedding_status: "ready",
          embedding_model: null,
          embedding_dim: null,
          deleted_at: now,
          modified_at: now,
        })
        .eq("id", row.id);
      if (updateError) {
        logger.error("Failed to clear markdown for non-human author.", { label, id: row.id, updateError });
      }
      return null;
    }
    logger.debug("Allowing bot-authored root review comment for embedding.", { label, id: row.id, authorType, docType });
  }

  const cleaned = cleanMarkdown(typeof row.markdown === "string" ? row.markdown : null);
  const isIssueDoc = docType === "issue" || docType === "pull_request";
  const minLength = isIssueDoc ? MIN_ISSUE_MARKDOWN_LENGTH : MIN_COMMENT_MARKDOWN_LENGTH;
  if ((docType === "issue_comment" || docType === "review_comment" || docType === "pull_request_review") && isCommandLikeContent(cleaned)) {
    logger.debug("Skipping embedding for command-like comment.", { label, id: row.id, docType });
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        markdown: null,
        embedding_status: "ready",
        embedding_model: null,
        embedding_dim: null,
        deleted_at: now,
        modified_at: now,
      })
      .eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for command-like comment.", { label, id: row.id, updateError });
    }
    return null;
  }
  if (!cleaned) {
    logger.debug("Skipping empty markdown embedding.", { label, id: row.id, docType });
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        markdown: null,
        embedding_status: "ready",
        embedding_model: null,
        embedding_dim: null,
        deleted_at: now,
        modified_at: now,
      })
      .eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for empty content.", { label, id: row.id, updateError });
    }
    return null;
  }
  if (isTooShort(cleaned, minLength)) {
    logger.debug("Skipping embedding for short content.", { label, id: row.id, length: cleaned.length, minLength, docType });
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        markdown: null,
        embedding_status: "ready",
        embedding_model: null,
        embedding_dim: null,
        deleted_at: now,
        modified_at: now,
      })
      .eq("id", row.id);
    if (updateError) {
      logger.error("Failed to clear markdown for short content.", { label, id: row.id, updateError });
    }
    return null;
  }

  return { row, embeddingSource: cleaned };
}

async function clearMarkdownForTokenLimit(params: {
  row: PendingRow;
  label: QueueLabel;
  supabase: SupabaseClient<Database>;
  logger: QueueLogger;
}): Promise<void> {
  const { row, label, supabase, logger } = params;
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("documents")
    .update({
      markdown: null,
      embedding_status: "ready",
      embedding_model: null,
      embedding_dim: null,
      deleted_at: now,
      modified_at: now,
    })
    .eq("id", row.id);
  if (updateError) {
    logger.error("Failed to clear markdown for token-limited document.", { label, id: row.id, updateError });
  }
}

function summarizePrepared(entries: PreparedEntry[]): {
  totalChars: number;
  avgChars: number;
  maxChars: number;
  minChars: number;
  docTypeCounts: Record<string, number>;
} {
  let totalChars = 0;
  let maxChars = 0;
  let minChars = Number.POSITIVE_INFINITY;
  const docTypeCounts: Record<string, number> = {};

  for (const entry of entries) {
    const length = entry.embeddingSource.length;
    totalChars += length;
    maxChars = Math.max(maxChars, length);
    minChars = Math.min(minChars, length);
    const docType = entry.row.doc_type;
    docTypeCounts[docType] = (docTypeCounts[docType] ?? 0) + 1;
  }

  return {
    totalChars,
    avgChars: entries.length ? Math.round(totalChars / entries.length) : 0,
    maxChars,
    minChars: minChars === Number.POSITIVE_INFINITY ? 0 : minChars,
    docTypeCounts,
  };
}

async function embedPreparedEntries(params: {
  entries: PreparedEntry[];
  embedder: VoyageEmbedding;
  settings: ReturnType<typeof getEmbeddingQueueSettings>;
  logger: QueueLogger;
  supabase: SupabaseClient<Database>;
  label: QueueLabel;
}): Promise<{ embeddings: number[][]; entries: PreparedEntry[]; stoppedEarly: boolean; skipped: number }> {
  const { entries, embedder, settings, logger, supabase, label } = params;
  if (entries.length === 0) {
    return { embeddings: [], entries: [], stoppedEarly: false, skipped: 0 };
  }

  try {
    const safeObservedTpm = safeTpmLimit(observedTpmLimit);
    const requestBudget = getRequestTokenBudget();
    const hardLimit = safeObservedTpm;
    const singleDocTpmMessage = "Estimated tokens exceed TPM cap for single document; clearing markdown.";

    async function splitAndEmbed(budget: number, logMessage: string, logContext: Record<string, unknown>) {
      const normalizedBudget = Math.max(1, Math.floor(budget));
      const { chunks, oversized } = splitEntriesByTokenBudget(entries, normalizedBudget);
      const oversizedSingles: PreparedEntry[][] = [];
      let skipped = 0;

      for (const { entry, estimatedTokens: tokens } of oversized) {
        if (hardLimit !== null && tokens > hardLimit) {
          logger.warn(singleDocTpmMessage, {
            label,
            id: entry.row.id,
            estimatedTokens: tokens,
            tpmLimit: hardLimit,
          });
          await clearMarkdownForTokenLimit({ row: entry.row, label, supabase, logger });
          skipped += 1;
          continue;
        }
        oversizedSingles.push([entry]);
      }

      logger.warn(logMessage, {
        label,
        batchSize: entries.length,
        estimatedTokens: estimateTokensForEntries(entries),
        requestBudget: normalizedBudget,
        tpmLimit: hardLimit,
        rpmLimit: observedRpmLimit,
        ...logContext,
      });

      let embeddings: number[][] = [];
      let keptEntries: PreparedEntry[] = [];
      let shouldStopEarly = false;

      for (const chunk of [...chunks, ...oversizedSingles]) {
        const chunkResult = await embedPreparedEntries({ entries: chunk, embedder, settings, logger, supabase, label });
        embeddings = embeddings.concat(chunkResult.embeddings);
        keptEntries = keptEntries.concat(chunkResult.entries);
        skipped += chunkResult.skipped;
        if (chunkResult.stoppedEarly) {
          shouldStopEarly = true;
          break;
        }
      }

      return { embeddings, entries: keptEntries, stoppedEarly: shouldStopEarly, skipped };
    }

    if (hardLimit !== null) {
      const estimatedTokens = estimateTokensForEntries(entries);
      if (entries.length === 1 && estimatedTokens > hardLimit) {
        logger.warn(singleDocTpmMessage, {
          label,
          id: entries[0]?.row.id,
          estimatedTokens,
          tpmLimit: hardLimit,
        });
        await clearMarkdownForTokenLimit({ row: entries[0].row, label, supabase, logger });
        return { embeddings: [], entries: [], stoppedEarly: false, skipped: 1 };
      }
    }

    const budget = requestBudget ?? hardLimit;
    if (budget !== null && entries.length > 1) {
      const estimatedTokens = estimateTokensForEntries(entries);
      if (estimatedTokens > budget) {
        return await splitAndEmbed(budget, "Estimated batch tokens exceed request budget; splitting batch.", {});
      }
    }

    const result = await createEmbeddingsWithRetry(
      embedder,
      entries.map((entry) => entry.embeddingSource),
      settings.maxRetries,
      settings.delayMs,
      logger
    );
    if (!result.embeddings) {
      if (result.rateLimited) {
        const detail = getErrorDetail(result.error);
        const tpmLimit = extractTpmLimit(detail);
        if (tpmLimit) {
          if (!observedTpmLimit || tpmLimit < observedTpmLimit) {
            observedTpmLimit = tpmLimit;
          }
          const safeLimit = safeTpmLimit(observedTpmLimit) ?? observedTpmLimit;
          if (entries.length === 1) {
            const estimatedTokens = estimateTokensForEntries(entries);
            if (safeLimit !== null && estimatedTokens > safeLimit) {
              logger.warn(singleDocTpmMessage, {
                label,
                id: entries[0]?.row.id,
                estimatedTokens,
                tpmLimit: safeLimit,
              });
              await clearMarkdownForTokenLimit({ row: entries[0].row, label, supabase, logger });
              return { embeddings: [], entries: [], stoppedEarly: false, skipped: 1 };
            }
            return { embeddings: [], entries: [], stoppedEarly: true, skipped: 0 };
          }
          const requestLimit = getRequestTokenBudget() ?? safeLimit ?? tpmLimit;
          return await splitAndEmbed(requestLimit, "Rate limit indicates TPM cap; splitting batch.", { detail });
        }
      }
      return { embeddings: [], entries: [], stoppedEarly: true, skipped: 0 };
    }
    if (result.embeddings.length !== entries.length) {
      logger.error("Embedding batch response size mismatch.", {
        label,
        expected: entries.length,
        received: result.embeddings.length,
      });
      return { embeddings: [], entries: [], stoppedEarly: true, skipped: 0 };
    }
    return { embeddings: result.embeddings, entries, stoppedEarly: false, skipped: 0 };
  } catch (error) {
    if (!isTokenLimitError(error)) {
      throw error;
    }
    const summary = summarizePrepared(entries);
    logger.warn("Voyage token limit hit; splitting batch.", {
      label,
      batchSize: entries.length,
      detail: getErrorDetail(error),
      totalChars: summary.totalChars,
      avgChars: summary.avgChars,
      maxChars: summary.maxChars,
      minChars: summary.minChars,
      docTypeCounts: summary.docTypeCounts,
    });
    if (entries.length === 1) {
      logger.warn("Token limit hit for single document; clearing markdown.", {
        label,
        id: entries[0]?.row.id,
        charLength: entries[0]?.embeddingSource.length ?? 0,
        detail: getErrorDetail(error),
      });
      await clearMarkdownForTokenLimit({ row: entries[0].row, label, supabase, logger });
      return { embeddings: [], entries: [], stoppedEarly: false, skipped: 1 };
    }

    const midpoint = Math.ceil(entries.length / 2);
    const left = await embedPreparedEntries({
      entries: entries.slice(0, midpoint),
      embedder,
      settings,
      logger,
      supabase,
      label,
    });
    if (left.stoppedEarly) {
      return left;
    }
    const right = await embedPreparedEntries({
      entries: entries.slice(midpoint),
      embedder,
      settings,
      logger,
      supabase,
      label,
    });

    return {
      embeddings: [...left.embeddings, ...right.embeddings],
      entries: [...left.entries, ...right.entries],
      stoppedEarly: right.stoppedEarly,
      skipped: left.skipped + right.skipped,
    };
  }
}

async function processPendingRows(params: {
  docTypes: DocumentType[];
  label: QueueLabel;
  supabase: SupabaseClient<Database>;
  embedder: VoyageEmbedding;
  settings: ReturnType<typeof getEmbeddingQueueSettings>;
  logger: QueueLogger;
}): Promise<{ processed: number; stoppedEarly: boolean; processedByType: Record<DocumentType, number> }> {
  const { docTypes, label, supabase, embedder, settings, logger } = params;
  const processedByType: Record<DocumentType, number> = {
    issue: 0,
    pull_request: 0,
    issue_comment: 0,
    review_comment: 0,
    pull_request_review: 0,
  };
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
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  if (!data || data.length === 0) {
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  const rows = (data as PendingRow[]).slice();
  const prepared: PreparedEntry[] = [];

  for (const row of rows) {
    const result = await preparePendingRow({ row, label, supabase, logger });
    if (result) {
      prepared.push(result);
    }
  }

  if (prepared.length === 0) {
    return { processed: 0, stoppedEarly: false, processedByType };
  }

  const embedResult = await embedPreparedEntries({ entries: prepared, embedder, settings, logger, supabase, label });
  if (embedResult.embeddings.length === 0) {
    return { processed: 0, stoppedEarly: embedResult.stoppedEarly, processedByType };
  }

  const updates = embedResult.entries.map((entry, index) => ({
    row: entry.row,
    embedding: embedResult.embeddings[index] ?? [],
  }));

  let processed = 0;
  const concurrency = Math.max(1, Math.min(settings.concurrency, updates.length));

  async function worker() {
    while (updates.length > 0) {
      const update = updates.shift();
      if (!update) {
        return;
      }
      if (!update.embedding.length) {
        logger.error("Embedding batch returned empty vector.", { label, id: update.row.id });
        const now = new Date().toISOString();
        const { error: clearError } = await supabase
          .from("documents")
          .update({
            markdown: null,
            embedding_status: "ready",
            embedding_model: null,
            embedding_dim: null,
            deleted_at: now,
            modified_at: now,
          })
          .eq("id", update.row.id);
        if (clearError) {
          logger.error("Failed to clear markdown after empty embedding.", {
            label,
            id: update.row.id,
            clearError,
          });
        }
        continue;
      }
      const { error: updateError } = await supabase
        .from("documents")
        .update({
          embedding: update.embedding,
          embedding_status: "ready",
          embedding_model: VOYAGE_EMBEDDING_MODEL,
          embedding_dim: VOYAGE_EMBEDDING_DIM,
          modified_at: new Date().toISOString(),
        })
        .eq("id", update.row.id);

      if (updateError) {
        logger.error("Failed to update embedding.", { label, id: update.row.id, updateError });
        continue;
      }
      const docType = update.row.doc_type as DocumentType;
      if (processedByType[docType] !== undefined) {
        processedByType[docType] += 1;
      }
      processed += 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (processed > 0) {
    await sleep(settings.delayMs);
  }

  return { processed, stoppedEarly: embedResult.stoppedEarly, processedByType };
}

export async function processPendingEmbeddings(params: { env: Env; clients: QueueClients; logger: QueueLogger }): Promise<QueueStats> {
  const { env, clients, logger } = params;
  const settings = getEmbeddingQueueSettings(env);

  if (!settings.enabled) {
    logger.debug("Embedding queue disabled; skipping pending embeddings.");
    return { issuesProcessed: 0, commentsProcessed: 0, stoppedEarly: false };
  }

  const embedder = new VoyageEmbedding(clients.voyage, { logger } as unknown as Context);

  const combinedResult = await processPendingRows({
    docTypes: ["issue", "pull_request", "issue_comment", "review_comment", "pull_request_review"],
    label: "documents",
    supabase: clients.supabase,
    embedder,
    settings,
    logger,
  });

  const issuesProcessed = (combinedResult.processedByType.issue ?? 0) + (combinedResult.processedByType.pull_request ?? 0);
  const commentsProcessed =
    (combinedResult.processedByType.issue_comment ?? 0) +
    (combinedResult.processedByType.review_comment ?? 0) +
    (combinedResult.processedByType.pull_request_review ?? 0);

  return {
    issuesProcessed,
    commentsProcessed,
    stoppedEarly: combinedResult.stoppedEarly,
  };
}

export function resetEmbeddingQueueRateLimits(): void {
  observedTpmLimit = null;
  observedRpmLimit = null;
  tpmWindowStartMs = null;
  tpmUsedTokens = 0;
  rpmHistory.length = 0;
}
