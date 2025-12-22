import { createAppAuth } from "@octokit/auth-app";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { createCronDatabase } from "./database-handler";
import { createReprocessClients, createReprocessContext, decodeConfig, decodeEnv, reprocessIssue } from "./reprocess";

async function main() {
  const logger = new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO);
  const octokit = new customOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(process.env.APP_ID),
      privateKey: process.env.APP_PRIVATE_KEY,
      installationId: process.env.APP_INSTALLATION_ID,
    },
  });

  const db = await createCronDatabase();
  let env;
  try {
    env = decodeEnv(process.env);
  } catch (error) {
    logger.error("Missing required env for reprocess; skipping cron run.", { error });
    return;
  }
  const config = decodeConfig();
  const clients = createReprocessClients(env);
  const repositories = await db.getAllRepositories();

  logger.info(`Loaded KV data.`, {
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

      const installation = await octokit.rest.apps.getRepoInstallation({
        owner: owner,
        repo: repo,
      });

      const repoOctokit = new customOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: Number(process.env.APP_ID),
          privateKey: process.env.APP_PRIVATE_KEY,
          installationId: installation.data.id,
        },
      });

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
            logger.info("Skipping pull request entry in cron list", { owner, repo, issueNumber });
            await db.removeIssue(url);
            continue;
          }

          const context = await createReprocessContext({
            issue,
            repository,
            octokit: repoOctokit,
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
