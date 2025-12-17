import { TypeBoxError } from "@sinclair/typebox";
import { LogReturn } from "@ubiquity-os/ubiquity-os-logger";

export function checkLlmRetryableState(error: unknown) {
  if (error instanceof Error) {
    const message = String(error.message ?? "");
    const match = /LLM API error:\s*(\d{3})\b/.exec(message);
    if (match) {
      const status = Number(match[1]);
      if (status === 429) return true;
      if (status >= 500) return true;
    }
  }
  return error instanceof SyntaxError || error instanceof TypeBoxError || error instanceof LogReturn;
}
