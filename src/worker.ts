import { swaggerUI } from "@hono/swagger-ui";
import { createAppAuth } from "@octokit/auth-app";
import { Value } from "@sinclair/typebox/value";
import { CommentHandler, createPlugin } from "@ubiquity-os/plugin-sdk";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { ExecutionContext } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import { env } from "hono/adapter";
import * as v from "valibot";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { createAdapters } from "./adapters/index";
import { issueMatching } from "./handlers/issue-matching";
import { parseGitHubUrl } from "./helpers/github";
import { initAdapters, runPlugin } from "./plugin";
import { Command } from "./types/command";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { Context } from "./types/index";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";

const urlSchema = v.pipe(v.string(), v.url(), v.regex(/https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/));

const querySchema = v.object({
  issueUrls: v.union([v.array(urlSchema), urlSchema]),
});

const responseSchema = v.array(v.unknown());

export default {
  async fetch(request: Request, environment: Env, executionCtx?: ExecutionContext) {
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
        logLevel: environment.LOG_LEVEL as LogLevel,
        kernelPublicKey: environment.KERNEL_PUBLIC_KEY,
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
      async (c) => {
        const urls = c.req.queries("issueUrls") as string[];
        async function handleUrl(url: string) {
          const { owner, repo, issue_number } = parseGitHubUrl(url);
          const honoEnv = env(c);
          const octokit = new customOctokit({
            authStrategy: createAppAuth,
            auth: {
              appId: honoEnv.APP_ID,
              privateKey: honoEnv.APP_PRIVATE_KEY,
              installationId: honoEnv.APP_INSTALLATION_ID,
            },
          });
          const issue = await octokit.rest.issues.get({ owner, repo, issue_number });
          const config = Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, {}));
          const logger = new Logs("debug") as unknown as Context<"issues.opened">["logger"];
          const ctx: Context<"issues.opened"> = {
            eventName: "issues.opened",
            command: null,
            commentHandler: new CommentHandler(),
            payload: {
              issue: issue.data,
            } as Context<"issues.opened">["payload"],
            octokit,
            env: honoEnv as Context<"issues.opened">["env"],
            config,
            logger,
            adapters: {} as Awaited<ReturnType<typeof createAdapters>>,
          };
          ctx.adapters = await initAdapters(ctx);
          const result = await issueMatching(ctx);
          if (!result) {
            return { [url]: [] };
          }
          return { [url]: result };
        }
        const res = await Promise.all(urls.map(handleUrl));
        return new Response(JSON.stringify(res), { status: 200 });
      }
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
    honoApp.get("/docs", swaggerUI({ url: "/openapi" }));

    return honoApp.fetch(request, env, executionCtx);
  },
};
