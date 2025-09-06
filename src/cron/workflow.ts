import { createAppAuth } from "@octokit/auth-app";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Context } from "../types/index";

export async function updateCronState(context: Context) {
  context.logger.debug("Updating the cron KV workflow state.");
  const db = context.adapters.kv;

  if (!process.env.GITHUB_REPOSITORY) {
    context.logger.error("Can't update the Action Workflow state as GITHUB_REPOSITORY is missing from the env.");
    return;
  }

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

  try {
    const appOctokit = new customOctokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.APP_ID,
        privateKey: process.env.APP_PRIVATE_KEY,
      },
    });

    let authOctokit;
    if (!process.env.APP_ID || !process.env.APP_PRIVATE_KEY) {
      context.logger.debug("APP_ID or APP_PRIVATE_KEY are missing from the env, will use the default Octokit instance.");
      authOctokit = context.octokit;
    } else {
      const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      authOctokit = new customOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: process.env.APP_ID,
          privateKey: process.env.APP_PRIVATE_KEY,
          installationId: installation.id,
        },
      });
    }

    const repositories = await db.getAllRepositories();
    const hasData = repositories.length > 0;

    if (hasData) {
      context.logger.verbose("Enabling cron.yml workflow.", { owner, repo });
      await authOctokit.rest.actions.enableWorkflow({
        owner,
        repo,
        workflow_id: "cron.yml",
      });
      context.logger.info("Cron workflow state updated with KV data", {
        totalRepos: repositories.length,
      });
    } else {
      context.logger.verbose("Disabling cron.yml workflow.");
      await authOctokit.rest.actions.disableWorkflow({
        owner,
        repo,
        workflow_id: "cron.yml",
      });
      context.logger.info("No data found in KV storage");
    }
  } catch (e) {
    context.logger.error("Error updating cron workflow state", { e });
  }
}
