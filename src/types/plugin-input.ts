import { StaticDecode, Type as T } from "@sinclair/typebox";

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
    embeddingMode: T.Union([T.Literal("sync"), T.Literal("async")], {
      default: "sync",
      description: "When set to async, embeddings are queued in KV and processed in small batches.",
    }),
    embeddingQueueMaxPerRun: T.Number({
      default: 3,
      description: "Max embeddings to process per event when async mode is enabled.",
    }),
    embeddingQueueDelaySeconds: T.Number({
      default: 60,
      description: "Base delay (seconds) before retrying a rate-limited embedding job.",
    }),
    embeddingQueueMaxAttempts: T.Number({
      default: 6,
      description: "Maximum retry attempts for a queued embedding job.",
    }),
    demoFlag: T.Boolean({ default: false, description: "When true, disables storing issues and comments in the database." }),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
