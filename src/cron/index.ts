import { createAppAuth } from "@octokit/auth-app";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { processPendingEmbeddings } from "./embedding-queue";
import { createCronDatabase } from "./database-handler";
import { createReprocessClients, createReprocessContext, decodeConfig, decodeEnv, reprocessIssue } from "./reprocess";
import { getEmbeddingQueueSettings, sleep } from "../utils/embedding-queue";
import type { Context } from "../types/index";

function normalizeError(error: unknown): Error | { stack: string } {
  return error instanceof Error ? error : { stack: String(error) };
}

async function main() {
  const logger = new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO);
  let env;
  try {
    env = decodeEnv(process.env);
  } catch (error) {
    logger.warn("Missing required env for reprocess; skipping cron run.", { error: normalizeError(error) });
    return;
  }
  const config = decodeConfig();
  const clients = createReprocessClients(env);
  const queueSettings = getEmbeddingQueueSettings(env);

  try {
    const queueResult = await processPendingEmbeddings({ env, clients, logger });
    logger.ok("Embedding queue processed", queueResult);
    if (queueResult.stoppedEarly) {
      logger.warn("Embedding queue stopped early due to rate limiting; skipping reprocess run.");
      return;
    }
  } catch (error) {
    logger.error("Embedding queue failed", { error: normalizeError(error) });
    if (queueSettings.enabled) {
      return;
    }
  }

  const octokit = new customOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(process.env.APP_ID),
      privateKey: process.env.APP_PRIVATE_KEY,
      installationId: process.env.APP_INSTALLATION_ID,
    },
  });

  const db = await createCronDatabase();
  const repositories = await db.getAllRepositories();

  logger.ok(`Loaded KV data.`, {
    repositories: repositories.length,
  });

  for (const { owner, repo, issueNumbers } of repositories) {
    if (issueNumbers.length === 0) {
      continue;
    }

    try {
      logger.info(`Triggering update`, {
        organization: owner,
        repository: repo,
        issueIds: issueNumbers,
      });

      const installation = await octokit.rest.apps.getRepoInstallation({ owner, repo });

      const repoOctokit = new customOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: Number(process.env.APP_ID),
          privateKey: process.env.APP_PRIVATE_KEY,
          installationId: installation.data.id,
        },
      });
      const appAuth = createAppAuth({
        appId: Number(process.env.APP_ID),
        privateKey: process.env.APP_PRIVATE_KEY ?? "",
        installationId: installation.data.id,
      });
      const { token: authToken } = await appAuth({ type: "installation" });

      const repoResponse = await repoOctokit.rest.repos.get({ owner, repo });
      const repository = repoResponse.data;

      for (const issueNumber of issueNumbers) {
        const url = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
        try {
          const { data: issue } = await repoOctokit.rest.issues.get({
            owner,
            repo,
            issue_number: issueNumber,
          });
          if (issue.pull_request) {
            logger.debug("Skipping pull request entry in cron list", { owner, repo, issueNumber });
            await db.removeIssue(url);
            continue;
          }

          const issuePayload = issue as Context<"issues.edited">["payload"]["issue"];
          const repositoryPayload = repository as Context<"issues.edited">["payload"]["repository"];

          const context = await createReprocessContext({
            issue: issuePayload,
            repository: repositoryPayload,
            octokit: repoOctokit,
            authToken,
            env,
            config,
            logger,
            clients,
          });

          await reprocessIssue(context, {
            updateIssue: false,
            runMatching: true,
            runDedupe: true,
            keepUpdateComment: false,
          });

          await db.removeIssue(url);
        } catch (err) {
          logger.error("Failed to reprocess individual issue", {
            organization: owner,
            repository: repo,
            issueNumber,
            url,
            err,
          });
        }

        if (queueSettings.enabled) {
          await sleep(queueSettings.delayMs);
        }
      }
    } catch (e) {
      logger.error("Failed to process repository", {
        owner,
        repo,
        issueNumbers,
        e,
      });
    }
  }
}

main().catch(console.error);
