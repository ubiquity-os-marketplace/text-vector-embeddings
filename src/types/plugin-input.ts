import { StaticDecode, Type as T } from "@sinclair/typebox";
import { llmList } from "./openrouter-types";

/**
 * This should contain the properties of the bot config
 * that are required for the plugin to function.
 *
 * The kernel will extract those and pass them to the plugin,
 * which are built into the context object from setup().
 */
export const pluginSettingsSchema = T.Object(
  {
    dedupeMatchThreshold: T.Number({ default: 0.95, description: "The minimum similarity score when considering existing issues to be duplicates." }),
    dedupeWarningThreshold: T.Number({ default: 0.75, description: "Issues above this similarity score will be marked as a potential duplicate." }),
    annotateThreshold: T.Number({
      default: 0.65,
      description: "The minimum similarity score for including similar issues as annotations in the comment footnotes.",
    }),
    jobMatchingThreshold: T.Number({ default: 0.75, description: "The minimum similarity score when considering users to be suitable for a job." }),
    alwaysRecommend: T.Optional(
      T.Number({ default: 0, description: "If set to a value greater than 0, the bot will always recommend contributors, regardless of the similarity score." })
    ),
    demoFlag: T.Boolean({ default: false, description: "When true, disables storing issues and comments in the database." }),
    llm: T.Object(
      {
        model: T.String({
          default: "deepseek/deepseek-chat-v3-0324:free",
          description: "The LLM model to use for generating responses.",
          examples: llmList,
        }),
        endpoint: T.String({
          default: "https://openrouter.ai/api/v1",
          description: "The LLM API endpoint.",
          examples: ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"],
        }),
        maxRetries: T.Number({ default: 5, description: "The maximum number of retries for LLM requests.", minimum: 0 }),
      },
      { default: {} }
    ),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
