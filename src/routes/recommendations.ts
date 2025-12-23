import { Value } from "@sinclair/typebox/value";
import { CommentHandler } from "@ubiquity-os/plugin-sdk";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Context as HonoContext } from "hono";
import { env } from "hono/adapter";
import { createAdapters } from "../adapters/index";
import { getAuthenticatedOctokit } from "../cron/workflow";
import { issueMatching, issueMatchingForUsers } from "../handlers/issue-matching";
import { parseGitHubUrl } from "../helpers/github";
import { initAdapters } from "../helpers/init-adapters";
import { Context, envSchema, pluginSettingsSchema } from "../types/index";

function getValidatedEnv(c: HonoContext) {
  const honoEnv = env(c);
  try {
    const errors = [...Value.Errors(envSchema, honoEnv)];
    if (errors.length) {
      console.dir(errors, { depth: null });
    }
    return Value.Decode(envSchema, Value.Default(envSchema, honoEnv));
  } catch (e) {
    throw new Error(`Failed to decode the environment variables: ${e}`);
  }
}

export async function recommendationsRoute(c: HonoContext) {
  const urls = c.req.queries("issueUrls") as string[];
  const users = ((c.req.queries("users") as string[] | undefined) ?? [])
    .flatMap((segment) => segment.split(/[\s,]+/))
    .map((user) => user.trim().replace(/^@/, ""))
    .filter(Boolean);
  const logger = new Logs("debug") as unknown as Context<"issues.opened">["logger"];
  const honoEnv = getValidatedEnv(c);

  function serializeMatchResult(result: Awaited<ReturnType<typeof issueMatching>> | Awaited<ReturnType<typeof issueMatchingForUsers>>) {
    if (!result) {
      return null;
    }
    const matchResultArray = result.matchResultArray instanceof Map ? Object.fromEntries(result.matchResultArray.entries()) : result.matchResultArray;
    return {
      ...result,
      matchResultArray,
    };
  }

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
    const appId = honoEnv.APP_ID;
    const appPrivateKey = honoEnv.APP_PRIVATE_KEY;
    let octokit;

    if (!appId || !appPrivateKey) {
      logger.warn("APP_ID or APP_PRIVATE_KEY are missing from the env, will use the default Octokit instance.");
      octokit = new customOctokit();
    } else {
      octokit = await getAuthenticatedOctokit({
        appId: honoEnv.APP_ID,
        appPrivateKey: honoEnv.APP_PRIVATE_KEY,
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
    const result = users.length > 0 ? await issueMatchingForUsers(ctx, users) : await issueMatching(ctx);
    return { [url]: serializeMatchResult(result) };
  }

  const res = await Promise.all(urls.map(handleUrl));
  return new Response(JSON.stringify(res.reduce((acc, curr) => ({ ...acc, ...curr }), {})), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
