import { createAppAuth } from "@octokit/auth-app";
import { createClient } from "@supabase/supabase-js";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { VoyageAIClient } from "voyageai";
import pkg from "../../package.json" with { type: "json" };
import { processPendingEmbeddings } from "./embedding-queue";
import { createCronDatabase } from "./database-handler";
import { Database } from "../types/database";
import { Env } from "../types/env";

async function main() {
  const logger = new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO);
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const voyageKey = process.env.VOYAGEAI_API_KEY;

  if (supabaseUrl && supabaseKey && voyageKey) {
    const supabase = createClient<Database>(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const voyage = new VoyageAIClient({ apiKey: voyageKey });
    const queueEnv: Env = {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_KEY: supabaseKey,
      VOYAGEAI_API_KEY: voyageKey,
      DENO_KV_URL: process.env.DENO_KV_URL,
      LOG_LEVEL: process.env.LOG_LEVEL,
      KERNEL_PUBLIC_KEY: process.env.KERNEL_PUBLIC_KEY,
      APP_ID: process.env.APP_ID,
      APP_PRIVATE_KEY: process.env.APP_PRIVATE_KEY,
      EMBEDDINGS_QUEUE_ENABLED: process.env.EMBEDDINGS_QUEUE_ENABLED,
      EMBEDDINGS_QUEUE_BATCH_SIZE: process.env.EMBEDDINGS_QUEUE_BATCH_SIZE,
      EMBEDDINGS_QUEUE_DELAY_MS: process.env.EMBEDDINGS_QUEUE_DELAY_MS,
      EMBEDDINGS_QUEUE_MAX_RETRIES: process.env.EMBEDDINGS_QUEUE_MAX_RETRIES,
    };

    try {
      const result = await processPendingEmbeddings({ env: queueEnv, clients: { supabase, voyage }, logger });
      logger.info("Embedding queue processed", result);
    } catch (error) {
      logger.error("Embedding queue failed", { error });
    }
  } else {
    logger.warn("Skipping embedding queue processing; SUPABASE_URL, SUPABASE_KEY, or VOYAGEAI_API_KEY is missing.");
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

      for (const issueNumber of issueNumbers) {
        const url = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
        try {
          const {
            data: { body = "" },
          } = await repoOctokit.rest.issues.get({
            owner: owner,
            repo: repo,
            issue_number: issueNumber,
          });

          const newBody = body + `\n<!-- ${pkg.name} update ${new Date().toISOString()} -->`;
          logger.info(`Updated body of ${url}`, { newBody });

          await repoOctokit.rest.issues.update({
            owner: owner,
            repo: repo,
            issue_number: issueNumber,
            body: newBody,
          });

          await db.removeIssue(url);
        } catch (err) {
          logger.error("Failed to update individual issue", {
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
