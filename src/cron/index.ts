import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, Logs } from "@ubiquity-os/ubiquity-os-logger";
import pkg from "../../package.json" with { type: "json" };
import { createCronDatabase } from "./database-handler";

async function main() {
  const logger = new Logs(process.env.LOG_LEVEL ?? LOG_LEVEL.INFO);
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(process.env.APP_ID),
      privateKey: process.env.APP_PRIVATE_KEY,
      installationId: process.env.APP_INSTALLATION_ID,
    },
  });

  const db = await createCronDatabase();
  const repositories = await db.getAllRepositories();

  logger.info(`Loaded KV data.`, {
    repositories: repositories.length,
  });

  for (const { organization, repository, issueIds } of repositories) {
    if (issueIds.length === 0) {
      continue;
    }

    try {
      logger.info(`Triggering update`, {
        organization,
        repository,
        issueIds,
      });

      const installation = await octokit.rest.apps.getRepoInstallation({
        owner: organization,
        repo: repository,
      });

      const issueNumber = issueIds[issueIds.length - 1];

      if (!issueNumber) {
        logger.error(`No issue number found for repository ${organization}/${repository}`);
        continue;
      }

      const repoOctokit = new customOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: Number(process.env.APP_ID),
          privateKey: process.env.APP_PRIVATE_KEY,
          installationId: installation.data.id,
        },
      });

      const {
        data: { body = "" },
      } = await repoOctokit.rest.issues.get({
        owner: organization,
        repo: repository,
        issue_number: issueNumber,
      });

      const newBody = body + `\n<!-- ${pkg.name} update ${new Date().toLocaleString()} -->`;
      logger.info(`Updated body ${issueNumber}`, { newBody });

      await repoOctokit.rest.issues.update({
        owner: organization,
        repo: repository,
        issue_number: issueNumber,
        body: newBody,
      });

      await db.removeIssueId(organization, repository, issueNumber);
    } catch (e) {
      logger.error("Failed to update the issue body", {
        organization,
        repository,
        issueIds,
        e,
      });
    }
  }
}

main().catch(console.error);
