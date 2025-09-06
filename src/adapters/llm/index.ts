import { retry } from "@ubiquity-os/plugin-sdk/helpers";
import { OpenAI } from "openai";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources";
import { checkLlmRetryableState } from "../../helpers/llm";
import { Context } from "../../types/index";

export class LlmAdapter {
  constructor(
    protected context: Context,
    private _llm: OpenAI = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: context.config.llm.endpoint,
    })
  ) {}

  public createCompletion(linkResponse: Response) {
    const { logger, config } = this.context;

    return retry(
      async () => {
        const imageData = await linkResponse.arrayBuffer();
        const linkContent = Buffer.from(imageData).toString("base64");
        this.context.logger.debug("Analyzing image", {
          href: linkResponse.url,
          model: this.context.config.llm.model,
        });
        const prompt: ChatCompletionCreateParamsNonStreaming = {
          model: this.context.config.llm.model,
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
          // @ts-expect-error Supported by OpenRouter: https://openrouter.ai/docs/features/message-transforms
          transforms: ["middle-out"],
        };
        const response = await this._llm.chat.completions.create(prompt);
        if (!response.choices?.length) {
          throw this.context.logger.warn("Failed to get a completion from the LLM.");
        }
        this.context.logger.debug("LLM response", { response });
        return response.choices[0].message.content;
      },
      {
        maxRetries: config.llm.maxRetries,
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
