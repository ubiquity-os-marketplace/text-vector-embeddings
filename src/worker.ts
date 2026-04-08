import { swaggerUI } from "@hono/swagger-ui";
import { createPlugin, Options } from "@ubiquity-os/plugin-sdk";
import { Manifest, resolveRuntimeManifest } from "@ubiquity-os/plugin-sdk/manifest";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";
import { ExecutionContext } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import "@hono/standard-validator"; // Ensure Deno deploy includes optional peer for hono-openapi.
import "@valibot/to-json-schema"; // Same here
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

function buildRuntimeManifest(request: Request) {
  const runtimeManifest = resolveRuntimeManifest(pluginManifest);
  return {
    ...runtimeManifest,
    homepage_url: new URL(request.url).origin,
  };
}

export default {
  async fetch(request: Request, serverInfo: Deno.ServeHandlerInfo, executionCtx?: ExecutionContext) {
    const runtimeManifest = buildRuntimeManifest(request);

    if (new URL(request.url).pathname === "/manifest.json") {
      return Response.json(runtimeManifest);
    }

    const environment = env<Env>(request as never);
    const honoApp = createPlugin<PluginSettings, Env, Command, SupportedEvents>(
      (context) => {
        return runPlugin({
          ...context,
          adapters: {} as Awaited<ReturnType<typeof createAdapters>>,
        });
      },
      runtimeManifest,
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
    if (typeof runtimeManifest.homepage_url === "string" && runtimeManifest.homepage_url.trim().length > 0) {
      openApiServers.push({ url: runtimeManifest.homepage_url, description: "Production Server" });
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
