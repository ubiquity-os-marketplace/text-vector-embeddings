import { TypeBoxError } from "@sinclair/typebox";
import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";
import ms, { StringValue } from "ms";

export function checkLlmRetryableState(error: unknown): boolean | number {
  if (error instanceof SyntaxError || error instanceof TypeBoxError || error instanceof LogReturn) {
    return true;
  }

  const status = extractStatus(error) ?? extractStatusFromMessage(error);
  if (!status) return false;

  if (status === 429) {
    const headers = extractHeaders(error);
    const tokenDelay = parseRetryAfter(headers, "x-ratelimit-reset-tokens");
    const requestDelay = parseRetryAfter(headers, "x-ratelimit-reset-requests");
    const retryAfter = parseRetryAfter(headers, "retry-after");
    const delays = [tokenDelay, requestDelay, retryAfter].filter((value): value is number => Number.isFinite(value));
    if (!delays.length) return true;
    return Math.max(...delays);
  }

  return status >= 500;
}

function extractStatus(error: unknown): number | null {
  const direct = getStatusFromSource(error);
  if (direct !== null) return direct;
  if (typeof error !== "object" || error === null || !("cause" in error)) return null;
  return getStatusFromSource((error as { cause?: unknown }).cause);
}

function getStatusFromSource(source: unknown): number | null {
  if (typeof source !== "object" || source === null) return null;
  const maybeError = source as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const candidates: unknown[] = [maybeError.status, maybeError.statusCode, maybeError.response?.status];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

function extractStatusFromMessage(error: unknown): number | null {
  const message = extractMessage(error);
  if (!message) return null;
  const match = STATUS_FROM_MESSAGE_REGEX.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

function extractMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  const maybeMessage = (error as { message?: unknown }).message;
  return typeof maybeMessage === "string" ? maybeMessage : undefined;
}

function extractHeaders(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const maybeError = error as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
  if (maybeError.headers) return maybeError.headers;
  if (maybeError.response?.headers) return maybeError.response.headers;
  const maybeCause = maybeError.cause;
  if (typeof maybeCause === "object" && maybeCause !== null) {
    const cause = maybeCause as { headers?: unknown; response?: { headers?: unknown } };
    if (cause.headers) return cause.headers;
    if (cause.response?.headers) return cause.response.headers;
  }
  return undefined;
}

function parseRetryAfter(headers: unknown, headerName: string): number | null {
  const value = getHeaderValue(headers, headerName);
  if (!value) return null;
  const delay = parseDelayMs(value, headerName.toLowerCase() === "retry-after");
  return Number.isFinite(delay) ? delay : null;
}

function getHeaderValue(headers: unknown, headerName: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const maybeHeaders = headers as { get?: unknown } & Record<string, unknown>;
  if (typeof maybeHeaders.get === "function") {
    const value = (maybeHeaders.get as (name: string) => string | null)(headerName);
    return typeof value === "string" ? value : undefined;
  }
  const direct = maybeHeaders[headerName] ?? maybeHeaders[headerName.toLowerCase()] ?? maybeHeaders[headerName.toUpperCase()];
  return typeof direct === "string" ? direct : undefined;
}

const STATUS_FROM_MESSAGE_REGEX = /\b(?:status(?: code)?|http|error)\b\D*(\d{3})(?!\d)/i;

function parseDelayMs(value: string, numericIsSeconds: boolean): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isNumericString(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return numericIsSeconds ? numeric * 1000 : numeric;
  }

  const duration = ms(trimmed as StringValue);
  if (Number.isFinite(duration)) return duration;

  return parseDateDelay(trimmed);
}

function parseDateDelay(value: string): number | null {
  const parsedDate = Date.parse(value);
  if (Number.isNaN(parsedDate)) return null;
  const delay = parsedDate - Date.now();
  return delay > 0 ? delay : 0;
}

function isNumericString(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value);
}
