import { swaggerUI } from "@hono/swagger-ui";
import { Value } from "@sinclair/typebox/value";
import { CommentHandler, createPlugin } from "@ubiquity-os/plugin-sdk";
import { Manifest } from "@ubiquity-os/plugin-sdk/manifest";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { ExecutionContext } from "hono";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import { ClientRateLimitInfo, ConfigType, rateLimiter, Store } from "hono-rate-limiter";
import { env } from "hono/adapter";
import { cors } from "hono/cors";
import { getConnInfo } from "hono/deno";
import process from "node:process";
import * as v from "valibot";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { createAdapters } from "./adapters/index";
import { getAuthenticatedOctokit } from "./cron/workflow";
import { issueMatching } from "./handlers/issue-matching";
import { parseGitHubUrl } from "./helpers/github";
import { initAdapters, runPlugin } from "./plugin";
import { Command } from "./types/command";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { Context } from "./types/index";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";

class KvStore implements Store {
  _options: ConfigType | undefined;
  prefix = "rate-limiter";

  constructor(readonly _store: Deno.Kv) {}

  async decrement(key: string) {
    const nowMs = Date.now();
    const record = await this.get(key);

    const existingResetTimeMs = record?.resetTime && new Date(record.resetTime).getTime();
    const isActiveWindow = existingResetTimeMs && existingResetTimeMs > nowMs;

    if (isActiveWindow && record) {
      const payload: ClientRateLimitInfo = {
        totalHits: Math.max(0, record.totalHits - 1),
        resetTime: new Date(existingResetTimeMs),
      };

      await this.updateRecord(key, payload);
    }
  }

  async resetKey(key: string) {
    await this._store.delete([this.prefix, key]);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const nowMs = Date.now();
    const record = await this.get(key);
    const defaultResetTime = new Date(nowMs + (this._options?.windowMs ?? 60000));

    const existingResetTimeMs = record?.resetTime && new Date(record.resetTime).getTime();
    const isActiveWindow = existingResetTimeMs && existingResetTimeMs > nowMs;

    const payload: ClientRateLimitInfo = {
      totalHits: isActiveWindow ? record.totalHits + 1 : 1,
      resetTime: isActiveWindow && existingResetTimeMs ? new Date(existingResetTimeMs) : defaultResetTime,
    };

    await this.updateRecord(key, payload);

    return payload;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const res = await this._store.get<ClientRateLimitInfo>([this.prefix, key]);
    return res?.value ?? undefined;
  }

  async updateRecord(key: string, payload: ClientRateLimitInfo): Promise<void> {
    await this._store.set([this.prefix, key], payload);
  }
}

const urlSchema = v.pipe(v.string(), v.url(), v.regex(/https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/));

const querySchema = v.object({
  issueUrls: v.union([v.array(urlSchema), urlSchema]),
});

const responseSchema = v.record(
  v.string(),
  v.union([
    v.object({
      matchResultArray: v.map(v.string(), v.array(v.string())),
      similarIssues: v.array(
        v.object({
          id: v.string(),
          issue_id: v.string(),
          similarity: v.number(),
        })
      ),
      sortedContributors: v.array(
        v.object({
          login: v.string(),
          matches: v.array(v.string()),
          maxSimilarity: v.number(),
        })
      ),
    }),
    v.null(),
  ])
);

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

    honoApp.use(cors());
    const kv = await Deno.openKv();
    honoApp.use(
      rateLimiter({
        windowMs: 60 * 1000,
        limit: 10,
        standardHeaders: "draft-7",
        keyGenerator: (c) => {
          return getConnInfo(c).remote.address ?? "";
        },
        store: new KvStore(kv),
      })
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
        const logger = new Logs("debug") as unknown as Context<"issues.opened">["logger"];
        async function handleUrl(url: string) {
          let owner, repo, issueNumber;
          try {
            const urlParts = parseGitHubUrl(url);
            owner = urlParts.owner;
            repo = urlParts.repo;
            issueNumber = urlParts.issue_number;
          } catch (e) {
            logger.warn("Failed to parse the GitHub url", { e });
            return { [url]: null };
          }
          const honoEnv = env(c);
          const appId = honoEnv.APP_ID;
          const appPrivateKey = honoEnv.APP_PRIVATE_KEY;
          let octokit;

          if (!appId || !appPrivateKey) {
            logger.warn("APP_ID or APP_PRIVATE_KEY are missing from the env, will use the default Octokit instance.");
            octokit = new customOctokit();
          } else {
            octokit = await getAuthenticatedOctokit({
              appId: honoEnv.APP_ID as string,
              appPrivateKey: honoEnv.APP_PRIVATE_KEY as string,
              owner,
              repo,
            });
          }
          const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
          const config = Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, {}));
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
          return { [url]: result };
        }
        const res = await Promise.all(urls.map(handleUrl));
        return new Response(JSON.stringify(res.reduce((acc, curr) => ({ ...acc, ...curr }), {})), { status: 200 });
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

    return honoApp.fetch(request, serverInfo, executionCtx);
  },
};
