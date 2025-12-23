import { retry } from "@ubiquity-os/plugin-sdk/helpers";
import { callLlm } from "@ubiquity-os/plugin-sdk";
import { checkLlmRetryableState } from "../../helpers/llm";
import { Context } from "../../types/index";

type ChatCompletionLike = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function isChatCompletionLike(value: unknown): value is ChatCompletionLike {
  return typeof value === "object" && value !== null && "choices" in value;
}

export class LlmAdapter {
  private static readonly _defaultMaxRetries = 5;

  constructor(protected context: Context) {}

  public createCompletion(linkResponse: Response) {
    const { logger } = this.context;

    return retry(
      async () => {
        const imageData = await linkResponse.arrayBuffer();
        const linkContent = Buffer.from(imageData).toString("base64");
        this.context.logger.debug("Analyzing image", {
          href: linkResponse.url,
        });
        const response = await callLlm(
          {
            max_tokens: 1000,
            messages: [
              {
                role: "system",
                content: "You are an assistant that analyzes external images and provides factual descriptions.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Provide a direct factual description in one paragraph, written in a single line. Start immediately with what you observe without introductory phrases. Focus on factual content and avoid subjective adjectives or emotional language. Do not use bullet points or numbering, only plain sentences.",
                  },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${linkContent}` } },
                ],
              },
            ],
          },
          this.context
        );

        if (isAsyncIterable(response)) {
          throw this.context.logger.error("Unexpected streaming response from the LLM.");
        }

        if (!isChatCompletionLike(response) || !Array.isArray(response.choices)) {
          throw this.context.logger.error("Unexpected LLM response shape.", { responseType: typeof response });
        }

        const content = response.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw this.context.logger.warn("Failed to get a completion from the LLM.");
        }
        this.context.logger.debug("LLM response", { response });
        return String(content);
      },
      {
        maxRetries: LlmAdapter._defaultMaxRetries,
        onError(e) {
          logger.warn("Failed to create a completion using the LLM.", {
            e,
          });
        },
        isErrorRetryable: checkLlmRetryableState,
      }
    );
  }
}
