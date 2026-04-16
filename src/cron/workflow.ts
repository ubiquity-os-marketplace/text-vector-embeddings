import { createAppAuth } from "@octokit/auth-app";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";

export async function getAuthenticatedOctokit({
  appPrivateKey,
  appId,
  owner,
  repo,
}: {
  appId: string;
  appPrivateKey: string;
  owner: string;
  repo: string;
}): Promise<InstanceType<typeof customOctokit>> {
  const appOctokit = new customOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId,
      privateKey: appPrivateKey,
    },
  });
  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
    owner,
    repo,
  });
  return new customOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId,
      privateKey: appPrivateKey,
      installationId: installation.id,
    },
  });
}

export async function updateCronState(context: Context) {
  context.logger.info("Updating the cron workflow state.");
  const issueStore = context.adapters.issueStore;

  if (!process.env.GITHUB_REPOSITORY) {
    context.logger.warn("Can't update the Action Workflow state as GITHUB_REPOSITORY is missing from the env.");
    return;
  }

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

  try {
    let authOctokit;
    if (!process.env.APP_ID || !process.env.APP_PRIVATE_KEY) {
      context.logger.warn("APP_ID or APP_PRIVATE_KEY are missing from the env, will use the default Octokit instance.");
      authOctokit = context.octokit;
    } else {
      authOctokit = await getAuthenticatedOctokit({
        appId: process.env.APP_ID,
        appPrivateKey: process.env.APP_PRIVATE_KEY,
        owner,
        repo,
      });
    }

    const hasTrackedIssues = await issueStore.hasData();
    const queueSettings = getEmbeddingQueueSettings(context.env);
    let hasPendingEmbeddings = false;
    if (queueSettings.enabled && context.adapters?.supabase?.super?.hasPendingEmbeddings) {
      hasPendingEmbeddings = await context.adapters.supabase.super.hasPendingEmbeddings();
    }
    const hasData = hasTrackedIssues || hasPendingEmbeddings;

    if (hasData) {
      context.logger.verbose("Enabling cron.yml workflow.", { owner, repo });
      await authOctokit.rest.actions.enableWorkflow({
        owner,
        repo,
        workflow_id: "cron.yml",
      });
      context.logger.ok("Cron workflow state updated with tracked issue data", {
        hasTrackedIssues,
        hasPendingEmbeddings,
      });
    } else {
      context.logger.verbose("Disabling cron.yml workflow.");
      await authOctokit.rest.actions.disableWorkflow({
        owner,
        repo,
        workflow_id: "cron.yml",
      });
      context.logger.debug("No tracked issue or embedding queue data found");
    }
  } catch (e) {
    context.logger.error("Error updating cron workflow state", { e });
  }
}
