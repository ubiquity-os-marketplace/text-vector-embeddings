import { swaggerUI } from "@hono/swagger-ui";
import { createPlugin } from "@ubiquity-os/plugin-sdk";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import type { ExecutionContext } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { createAdapters } from "./adapters/index";
import { runPlugin } from "./plugin";
import { Command } from "./types/command";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";

const querySchema = v.object({
  issueUrl: v.union([v.array(v.string()), v.string()]),
});

const responseSchema = v.array(v.object({ userId: v.string(), score: v.number() }));

export default {
  async fetch(request: Request, env: Env, executionCtx?: ExecutionContext) {
    const honoApp = createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin({
          ...context,
          adapters: {} as Awaited<ReturnType<typeof createAdapters>>,
        });
      },
      manifest as Manifest,
      {
        envSchema: envSchema,
        postCommentOnError: true,
        settingsSchema: pluginSettingsSchema,
        logLevel: env.LOG_LEVEL as LogLevel,
        kernelPublicKey: env.KERNEL_PUBLIC_KEY,
        bypassSignatureVerification: process.env.NODE_ENV === "local",
      }
    );

    honoApp.get(
      "/recommendations",
      describeRoute({
        description: "Get recommended users for a given issue url",
        responses: {
          200: {
            description: "Successful response",
            content: {
              "application/json": { schema: resolver(responseSchema) },
            },
          },
        },
      }),
      validator("query", querySchema),
      () => new Response("OK")
    );
    honoApp.get(
      "/openapi",
      openAPIRouteHandler(honoApp, {
        documentation: {
          info: {
            title: pkg.name,
            version: pkg.version,
            description: pkg.description,
          },
          servers: [
            { url: "http://localhost:4004", description: "Local Server" },
            { url: manifest.homepage_url, description: "Production Server" },
          ],
        },
      })
    );
    honoApp.get("/ui", swaggerUI({ url: "/openapi" }));

    return honoApp.fetch(request, env, executionCtx);
  },
};
