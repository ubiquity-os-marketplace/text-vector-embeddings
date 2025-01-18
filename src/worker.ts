import { createPlugin } from "@ubiquity-os/plugin-sdk";
import type { ExecutionContext } from "hono";
import { createAdapters } from "./adapters";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";
import manifest from "../manifest.json";
import { runPlugin } from "./plugin";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import { Command } from "./types/command";

export default {
  async fetch(request: Request, env: Env, executionCtx?: ExecutionContext) {
    return createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin({
          ...context,
          adapters: {} as ReturnType<typeof createAdapters>,
        });
      },
      manifest as Manifest,
      {
        envSchema: envSchema,
        postCommentOnError: true,
        settingsSchema: pluginSettingsSchema,
        logLevel: env.LOG_LEVEL as LogLevel,
        kernelPublicKey: env.KERNEL_PUBLIC_KEY,
      }
    ).fetch(request, env, executionCtx);
  },
};
