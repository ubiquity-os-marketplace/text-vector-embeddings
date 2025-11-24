import { createActionsPlugin } from "@ubiquity-os/plugin-sdk";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import { createAdapters } from "./adapters/index";
import { runPlugin } from "./plugin";
import { Env, envSchema } from "./types/env";
import { SupportedEvents } from "./types/index";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";

createActionsPlugin<PluginSettings, Env, null, SupportedEvents>(
  async (context) => {
    await runPlugin({
      ...context,
      adapters: {} as Awaited<ReturnType<typeof createAdapters>>,
    });
    process.exit(0);
  },
  {
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    settingsSchema: pluginSettingsSchema as never,
    envSchema: envSchema as never,
    ...(process.env.KERNEL_PUBLIC_KEY && { kernelPublicKey: process.env.KERNEL_PUBLIC_KEY }),
    postCommentOnError: true,
  }
).catch((error) => {
  console.error(error);
  process.exit(1);
});
