import { Value } from "@sinclair/typebox/value";
import { CommentHandler } from "@ubiquity-os/plugin-sdk";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Context as HonoContext } from "hono";
import { env } from "hono/adapter";
import { createAdapters } from "../adapters/index";
import { getAuthenticatedOctokit } from "../cron/workflow";
import { issueMatching } from "../handlers/issue-matching";
import { parseGitHubUrl } from "../helpers/github";
import { initAdapters } from "../plugin";
import { Context, pluginSettingsSchema } from "../types/index";

export async function recommendationsRoute(c: HonoContext) {
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
  return new Response(JSON.stringify(res.reduce((acc, curr) => ({ ...acc, ...curr }), {})), { status: 200, headers: { "Content-Type": "application/json" } });
}
