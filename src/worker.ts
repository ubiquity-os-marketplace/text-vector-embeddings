import { swaggerUI } from "@hono/swagger-ui";
import { createPlugin, Options } from "@ubiquity-os/plugin-sdk";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import { ExecutionContext } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import "@hono/standard-validator"; // Ensure Deno deploy includes optional peer for hono-openapi.
import { rateLimiter } from "hono-rate-limiter";
import { env } from "hono/adapter";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/deno";
import process from "node:process";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { createAdapters } from "./adapters/index";
import { KvStore } from "./helpers/rate-limiter";
import { runPlugin } from "./plugin";
import { recommendationsRoute } from "./routes/recommendations";
import { Command } from "./types/command";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";
import { querySchema, responseSchema } from "./validators";

const kv = await Deno.openKv();
const pluginManifest = manifest as Manifest & { homepage_url?: string };

export default {
  async fetch(request: Request, serverInfo: Deno.ServeHandlerInfo, executionCtx?: ExecutionContext) {
    const environment = env<Env>(request as never);
    const honoApp = createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin({
          ...context,
          adapters: {} as Awaited<ReturnType<typeof createAdapters>>,
        });
      },
      pluginManifest,
      {
        settingsSchema: pluginSettingsSchema as unknown as Options["settingsSchema"],
        envSchema: envSchema as unknown as Options["envSchema"],
        postCommentOnError: true,
        logLevel: environment.LOG_LEVEL as LogLevel,
        kernelPublicKey: environment.KERNEL_PUBLIC_KEY,
        bypassSignatureVerification: process.env.NODE_ENV === "local",
      }
    );

    honoApp.use(cors());
    honoApp.use(
      rateLimiter({
        windowMs: 60 * 1000,
        limit: 100,
        standardHeaders: "draft-7",
        keyGenerator: (c) => {
          return getConnInfo(c).remote.address ?? "";
        },
        store: new KvStore(kv),
      })
    );

    const openApiServers = [{ url: "http://localhost:4004", description: "Local Server" }];
    if (typeof pluginManifest.homepage_url === "string" && pluginManifest.homepage_url.trim().length > 0) {
      openApiServers.push({ url: pluginManifest.homepage_url, description: "Production Server" });
    }

    honoApp.get(
      "/recommendations",
      describeRoute({
        description: "Get recommended users for a given issue url (optionally filtered to a list of users)",
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
      recommendationsRoute
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
          servers: openApiServers,
        },
      })
    );
    honoApp.get("/docs", swaggerUI({ url: "/openapi" }));

    return honoApp.fetch(request, serverInfo, executionCtx);
  },
};
