import { Env } from "../types/env";

export type EmbeddingQueueSettings = {
  enabled: boolean;
  batchSize: number;
  delayMs: number;
  maxRetries: number;
};

const isQueueEnabledByDefault = true;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function getEmbeddingQueueSettings(env: Env): EmbeddingQueueSettings {
  return {
    enabled: parseBoolean(env.EMBEDDINGS_QUEUE_ENABLED, isQueueEnabledByDefault),
    batchSize: parsePositiveInt(env.EMBEDDINGS_QUEUE_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    delayMs: parseNonNegativeInt(env.EMBEDDINGS_QUEUE_DELAY_MS, DEFAULT_DELAY_MS),
    maxRetries: parseNonNegativeInt(env.EMBEDDINGS_QUEUE_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  };
}

export function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
