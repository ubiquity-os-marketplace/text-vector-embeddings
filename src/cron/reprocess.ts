import { Value } from "@sinclair/typebox/value";
import { CommentHandler } from "@ubiquity-os/plugin-sdk";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { LlmAdapter } from "../adapters/llm";
import { Comment } from "../adapters/supabase/helpers/comment";
import { Issue } from "../adapters/supabase/helpers/issues";
import { SuperSupabase } from "../adapters/supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "../adapters/voyage/helpers/embedding";
import { SuperVoyage } from "../adapters/voyage/helpers/voyage";
import { issueDedupe } from "../handlers/issue-deduplication";
import { issueMatchingWithComment } from "../handlers/issue-matching";
import { updateIssue } from "../handlers/update-issue";
import { parseGitHubUrl } from "../helpers/github";
import { Context, Env, PluginSettings, envSchema, pluginSettingsSchema } from "../types/index";
import { Database } from "../types/database";
import { CronDatabaseClient } from "./database-handler";

type IssuePayload = Context<"issues.edited">["payload"]["issue"];
type RepoPayload = Context<"issues.edited">["payload"]["repository"];

export type ReprocessOptions = {
  updateIssue?: boolean;
  runMatching?: boolean;
  runDedupe?: boolean;
  keepUpdateComment?: boolean;
};

type ReprocessClients = {
  supabase: SupabaseClient<Database>;
  voyage: VoyageAIClient;
};

class MemoryCronDatabase implements CronDatabaseClient {
  private readonly _entries = new Map<string, number[]>();

  async getIssueNumbers(owner: string, repo: string): Promise<number[]> {
    return this._entries.get(`${owner}/${repo}`) ?? [];
  }

  async addIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = `${owner}/${repo}`;
    const current = this._entries.get(key) ?? [];
    if (!current.includes(issue_number)) {
      this._entries.set(key, [...current, issue_number]);
    }
  }

  async removeIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = `${owner}/${repo}`;
    const current = this._entries.get(key) ?? [];
    const filtered = current.filter((id) => id !== issue_number);
    if (filtered.length === 0) {
      this._entries.delete(key);
    } else {
      this._entries.set(key, filtered);
    }
  }

  async updateIssue(currentUrl: string, newUrl: string): Promise<void> {
    await this.removeIssue(currentUrl);
    await this.addIssue(newUrl);
  }

  async getAllRepositories(): Promise<Array<{ owner: string; repo: string; issueNumbers: number[] }>> {
    const repositories: Array<{ owner: string; repo: string; issueNumbers: number[] }> = [];
    for (const [key, issueNumbers] of this._entries) {
      const [owner, repo] = key.split("/");
      if (!owner || !repo) {
        continue;
      }
      repositories.push({ owner, repo, issueNumbers });
    }
    return repositories;
  }
}

export function decodeEnv(values: Record<string, unknown>): Env {
  return Value.Decode(envSchema, Value.Default(envSchema, values));
}

export function decodeConfig(values: Record<string, unknown> = {}): PluginSettings {
  return Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, values));
}

export function createReprocessClients(env: Env): ReprocessClients {
  return {
    supabase: createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY),
    voyage: new VoyageAIClient({ apiKey: env.VOYAGEAI_API_KEY }),
  };
}

export function createReprocessAdapters(context: Context, clients: ReprocessClients): Context["adapters"] {
  const kv: CronDatabaseClient = new MemoryCronDatabase();
  return {
    supabase: {
      comment: new Comment(clients.supabase, context),
      issue: new Issue(clients.supabase, context),
      super: new SuperSupabase(clients.supabase, context),
    },
    voyage: {
      embedding: new VoyageEmbedding(clients.voyage, context),
      super: new SuperVoyage(clients.voyage, context),
    },
    kv,
    llm: new LlmAdapter(context),
  };
}

export async function createReprocessContext(params: {
  issue: IssuePayload;
  repository: RepoPayload;
  octokit: Context<"issues.edited">["octokit"];
  authToken?: string;
  env: Env;
  config?: PluginSettings;
  logger?: Context<"issues.edited">["logger"];
  clients?: ReprocessClients;
}): Promise<Context<"issues.edited">> {
  const logger = params.logger ?? (new Logs((process.env.LOG_LEVEL as LogLevel) ?? LOG_LEVEL.INFO) as unknown as Context<"issues.edited">["logger"]);
  const config = params.config ?? decodeConfig();
  const ctx: Context<"issues.edited"> = {
    eventName: "issues.edited",
    command: null,
    commentHandler: new CommentHandler(),
    authToken: params.authToken ?? "",
    payload: {
      issue: params.issue,
      repository: params.repository,
      sender: { type: "Bot" },
    } as Context<"issues.edited">["payload"],
    octokit: params.octokit,
    env: params.env,
    config,
    logger,
    adapters: {} as Context<"issues.edited">["adapters"],
  };
  const clients = params.clients ?? createReprocessClients(params.env);
  ctx.adapters = createReprocessAdapters(ctx, clients);
  return ctx;
}

export async function reprocessIssue(context: Context<"issues.edited">, options: ReprocessOptions = {}) {
  const shouldRunUpdate = options.updateIssue ?? true;
  const shouldRunMatching = options.runMatching ?? true;
  const shouldRunDedupe = options.runDedupe ?? true;
  const shouldKeepUpdateComment = options.keepUpdateComment ?? false;

  if (shouldRunUpdate) {
    await updateIssue(context);
  }

  if (shouldRunMatching) {
    await issueMatchingWithComment(context);
  }

  if (shouldRunDedupe) {
    await issueDedupe(context, { keepUpdateComment: shouldKeepUpdateComment });
  }
}
