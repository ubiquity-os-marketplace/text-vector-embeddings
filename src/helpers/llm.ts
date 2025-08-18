import ms, { StringValue } from "ms";
import { OpenAI } from "openai";

export function checkLlmRetryableState(error: unknown) {
  if (error instanceof OpenAI.APIError && error.status) {
    if ([500, 503].includes(error.status)) {
      return true;
    }
    if (error.status === 429 && error.headers) {
      const retryAfterTokens = error.headers["x-ratelimit-reset-tokens"];
      const retryAfterRequests = error.headers["x-ratelimit-reset-requests"];
      if (!retryAfterTokens || !retryAfterRequests) {
        return true;
      }
      const retryAfter = Math.max(ms(retryAfterTokens as StringValue), ms(retryAfterRequests as StringValue));
      return Number.isFinite(retryAfter) ? retryAfter : true;
    }
  }
  return false;
}
