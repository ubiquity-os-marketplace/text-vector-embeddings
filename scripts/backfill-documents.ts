import { createClient } from "@supabase/supabase-js";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import "dotenv/config";
import { VoyageAIClient } from "voyageai";
import { Embedding as VoyageEmbedding } from "../src/adapters/voyage/helpers/embedding";
import { buildPullRequestMarkdown } from "../src/handlers/pull-request-review-utils";
import { Database } from "../src/types/database";
import type { Context } from "../src/types/index";
import { cleanMarkdown, isTooShort, MIN_ISSUE_MARKDOWN_LENGTH } from "../src/utils/embedding-content";

type DocType = "issue" | "pull_request";

type CliOptions = {
  repos: string[];
  orgs: string[];
  types: Set<DocType>;
  token?: string;
  limit?: number;
  since?: number;
  dryRun: boolean;
  withEmbeddings: boolean;
  updateExisting: boolean;
  delayMs: number;
};

type ExistingDoc = {
  docType: DocType;
  modifiedAt?: string | null;
};

type RepoInfo = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    id?: number;
    type?: string;
    site_admin?: boolean;
  };
};

type GraphAuthor = {
  __typename: string;
  login?: string | null;
  databaseId?: number | null;
} | null;

type IssueNode = {
  id: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  author: GraphAuthor;
};

type PullRequestNode = {
  id: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  url: string;
  author: GraphAuthor;
};

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

const ISSUE_QUERY = `
  query RepoIssues($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          stateReason
          createdAt
          updatedAt
          closedAt
          url
          author {
            __typename
            login
            ... on User { databaseId }
          }
        }
      }
    }
  }
`;

const PULL_QUERY = `
  query RepoPulls($owner: String!, $repo: String!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          createdAt
          updatedAt
          closedAt
          mergedAt
          url
          author {
            __typename
            login
            ... on User { databaseId }
          }
        }
      }
    }
  }
`;

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/backfill-documents.ts [--repo owner/repo] [--org org] [options]

Options:
  --repo                 Repeatable. Owner/repo to backfill.
  --org                  Repeatable. Org to backfill all repos.
  --types                Comma-separated: issue,pull_request (default: both).
  --limit                Max items per repo (default: unlimited).
  --since                ISO date; skip items updated before this date.
  --update-existing       Update records when GitHub updatedAt is newer.
  --with-embeddings       Generate Voyage embeddings for new docs.
  --dry-run               Do not write to Supabase.
  --delay-ms              Sleep between pages (default: 0).
  --token                 GitHub token override (default: GITHUB_TOKEN/GH_TOKEN).
  --help                  Show this help.

Env:
  SUPABASE_URL + SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY),
  SUPABASE_PROJECT_ID (optional), VOYAGEAI_API_KEY (if --with-embeddings).
`);
}

function parseDocTypes(value: string | undefined): Set<DocType> {
  const allowed = new Set<DocType>(["issue", "pull_request"]);
  const types = new Set<DocType>();
  if (!value) {
    allowed.forEach((type) => types.add(type));
    return types;
  }
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (allowed.has(trimmed as DocType)) {
      types.add(trimmed as DocType);
    } else {
      throw new Error(`Unsupported doc type: ${trimmed}`);
    }
  }
  if (types.size === 0) {
    throw new Error("No valid doc types provided.");
  }
  return types;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repos: [],
    orgs: [],
    types: new Set<DocType>(["issue", "pull_request"]),
    dryRun: false,
    withEmbeddings: false,
    updateExisting: false,
    delayMs: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        options.repos.push(argv[index + 1] || "");
        index += 1;
        break;
      case "--org":
        options.orgs.push(argv[index + 1] || "");
        index += 1;
        break;
      case "--types":
        options.types = parseDocTypes(argv[index + 1]);
        index += 1;
        break;
      case "--limit":
        options.limit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--since":
        options.since = Date.parse(argv[index + 1] || "");
        index += 1;
        break;
      case "--update-existing":
        options.updateExisting = true;
        break;
      case "--with-embeddings":
        options.withEmbeddings = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--delay-ms":
        options.delayMs = Number(argv[index + 1]) || 0;
        index += 1;
        break;
      case "--token":
        options.token = argv[index + 1];
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return options;
}

function resolveSupabaseUrl(): string {
  const raw = process.env.SUPABASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  const projectId = process.env.SUPABASE_PROJECT_ID?.trim();
  return projectId ? `https://${projectId}.supabase.co` : "";
}

function resolveSupabaseKey(): string {
  return process.env.SUPABASE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim() || "";
}

function normalizeRepo(value: string): string {
  return value.trim().replace(/\.git$/, "");
}

async function sleepMs(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function extractRepoFullName(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const repo = record.repository as Record<string, unknown> | undefined;
  if (!repo) return "";
  const fullName = repo.full_name;
  if (typeof fullName === "string" && fullName.trim()) return fullName.trim();
  const name = typeof repo.name === "string" ? repo.name.trim() : "";
  const ownerObj = repo.owner as Record<string, unknown> | undefined;
  const owner = ownerObj && typeof ownerObj.login === "string" ? ownerObj.login.trim() : "";
  if (!owner || !name) return "";
  return `${owner}/${name}`;
}

async function listReposForOrg(octokit: InstanceType<typeof Octokit>, org: string): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page, type: "all" });
    for (const repo of data) {
      repos.push(`${org}/${repo.name}`);
    }
    if (data.length < 100) break;
    page += 1;
  }
  return repos;
}

async function loadExistingDocs(
  supabase: ReturnType<typeof createClient<Database>>,
  docTypes: DocType[],
  targetRepos: Set<string>
): Promise<{ byRepo: Map<string, Map<string, ExistingDoc>>; byId: Map<string, ExistingDoc> }> {
  const perPage = 1000;
  let offset = 0;
  const byRepo = new Map<string, Map<string, ExistingDoc>>();
  const byId = new Map<string, ExistingDoc>();

  while (true) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, doc_type, payload, modified_at")
      .in("doc_type", docTypes)
      .range(offset, offset + perPage - 1);
    if (error) {
      throw new Error(`Supabase fetch failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const key = `${row.doc_type}:${row.id}`;
      byId.set(key, { docType: row.doc_type as DocType, modifiedAt: row.modified_at });
      const fullName = extractRepoFullName(row.payload);
      if (!fullName || (targetRepos.size > 0 && !targetRepos.has(fullName))) continue;
      const repoMap = byRepo.get(fullName) ?? new Map<string, ExistingDoc>();
      repoMap.set(key, { docType: row.doc_type as DocType, modifiedAt: row.modified_at });
      byRepo.set(fullName, repoMap);
    }

    if (data.length < perPage) break;
    offset += perPage;
  }

  return { byRepo, byId };
}

function isHumanAuthor(author: GraphAuthor): boolean {
  return author?.__typename === "User";
}

function shouldProcessRecord(existing: ExistingDoc | undefined, updatedAt: string, updateExisting: boolean): boolean {
  if (!existing) return true;
  if (!updateExisting) return false;
  const existingTs = existing?.modifiedAt ? Date.parse(existing.modifiedAt) : Number.NaN;
  const updatedTs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedTs)) return true;
  if (!Number.isFinite(existingTs)) return true;
  return updatedTs > existingTs;
}

function buildRepoPayload(info: RepoInfo): Record<string, unknown> {
  return {
    id: info.id,
    node_id: info.node_id,
    name: info.name,
    full_name: info.full_name,
    private: info.private,
    owner: {
      login: info.owner.login,
      id: info.owner.id ?? null,
      type: info.owner.type ?? null,
      site_admin: info.owner.site_admin ?? false,
    },
  };
}

function buildIssuePayload(node: IssueNode, repoPayload: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "backfill",
    issue: {
      node_id: node.id,
      number: node.number,
      title: node.title ?? "",
      body: node.body ?? "",
      state: node.state,
      state_reason: node.stateReason,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      closed_at: node.closedAt,
      html_url: node.url,
      user: {
        login: node.author?.login ?? null,
        id: node.author?.databaseId ?? null,
        type: node.author?.__typename ?? null,
      },
    },
    repository: repoPayload,
    sender: { login: "backfill" },
  };
}

function buildPullRequestPayload(node: PullRequestNode, repoPayload: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "backfill",
    pull_request: {
      node_id: node.id,
      number: node.number,
      title: node.title ?? "",
      body: node.body ?? "",
      state: node.state,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      closed_at: node.closedAt,
      merged_at: node.mergedAt,
      html_url: node.url,
      user: {
        login: node.author?.login ?? null,
        id: node.author?.databaseId ?? null,
        type: node.author?.__typename ?? null,
      },
    },
    repository: repoPayload,
    sender: { login: "backfill" },
  };
}

async function fetchRepoInfo(octokit: InstanceType<typeof Octokit>, owner: string, repo: string): Promise<RepoInfo> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  if (!data.owner) {
    throw new Error(`Repository ${owner}/${repo} missing owner data.`);
  }
  return {
    id: data.id,
    node_id: data.node_id,
    name: data.name,
    full_name: data.full_name ?? `${owner}/${repo}`,
    private: data.private ?? false,
    owner: {
      login: data.owner.login,
      id: data.owner.id,
      type: data.owner.type,
      site_admin: data.owner.site_admin,
    },
  };
}

async function fetchIssuePage(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  after: string | null
): Promise<{ nodes: IssueNode[]; pageInfo: PageInfo }> {
  const response = await octokit.graphql<{ repository: { issues: { nodes: IssueNode[]; pageInfo: PageInfo } } }>(ISSUE_QUERY, {
    owner,
    repo,
    after,
  });
  return response.repository.issues;
}

async function fetchPullPage(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  after: string | null
): Promise<{ nodes: PullRequestNode[]; pageInfo: PageInfo }> {
  const response = await octokit.graphql<{ repository: { pullRequests: { nodes: PullRequestNode[]; pageInfo: PageInfo } } }>(PULL_QUERY, {
    owner,
    repo,
    after,
  });
  return response.repository.pullRequests;
}

async function upsertDocument(supabase: ReturnType<typeof createClient<Database>>, record: Record<string, unknown>, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const { error } = await supabase.from("documents").upsert(record as unknown as Database["public"]["Tables"]["documents"]["Insert"], { onConflict: "id" });
  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }
}

async function updateDocument(
  supabase: ReturnType<typeof createClient<Database>>,
  nodeId: string,
  updates: Record<string, unknown>,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;
  const { error } = await supabase
    .from("documents")
    .update(updates as unknown as Database["public"]["Tables"]["documents"]["Update"])
    .eq("id", nodeId);
  if (error) {
    throw new Error(`Supabase update failed: ${error.message}`);
  }
}

async function processIssues(params: {
  octokit: InstanceType<typeof Octokit>;
  supabase: ReturnType<typeof createClient<Database>>;
  repoInfo: RepoInfo;
  existing: Map<string, ExistingDoc>;
  options: CliOptions;
  voyageEmbedding: VoyageEmbedding | null;
}): Promise<{ inserted: number; updated: number; skipped: number }> {
  const { octokit, supabase, repoInfo, existing, options, voyageEmbedding } = params;
  let cursor: string | null = null;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let processed = 0;
  const repoPayload = buildRepoPayload(repoInfo);
  const isPrivate = repoInfo.private;

  while (true) {
    const { nodes, pageInfo } = await fetchIssuePage(octokit, repoInfo.owner.login, repoInfo.name, cursor);
    for (const node of nodes) {
      if (options.limit && processed >= options.limit) return { inserted, updated, skipped };
      processed += 1;

      const updatedAt = node.updatedAt;
      if (options.since && Number.isFinite(options.since) && Date.parse(updatedAt) < options.since) {
        skipped += 1;
        continue;
      }

      const existingKey = `issue:${node.id}`;
      const existingEntry = existing.get(existingKey);
      const shouldProcess = shouldProcessRecord(existingEntry, updatedAt, options.updateExisting);
      if (!shouldProcess) {
        skipped += 1;
        continue;
      }

      const isHuman = isHumanAuthor(node.author);
      const authorId = isHuman && node.author?.databaseId ? node.author.databaseId : -1;
      const rawMarkdown = [node.body ?? "", node.title ?? ""].filter(Boolean).join(" ").trim();
      const cleaned = cleanMarkdown(rawMarkdown);
      const isShort = isTooShort(cleaned, MIN_ISSUE_MARKDOWN_LENGTH);
      const storedMarkdown = !isShort ? rawMarkdown : null;

      let embedding: number[] | null = null;
      if (options.withEmbeddings && voyageEmbedding && !isPrivate && isHuman && storedMarkdown) {
        embedding = await voyageEmbedding.createEmbedding(cleaned);
      }

      const payload = isPrivate ? null : buildIssuePayload(node, repoPayload);
      const record = {
        id: node.id,
        doc_type: "issue",
        parent_id: null,
        markdown: isPrivate ? null : storedMarkdown,
        // Store as JSON text to match existing ingestion behavior.
        embedding: embedding ? JSON.stringify(embedding) : null,
        author_id: authorId,
        modified_at: node.updatedAt,
        payload,
      };

      if (!existingEntry) {
        await upsertDocument(supabase, record, options.dryRun);
        inserted += 1;
      } else {
        const updates: Record<string, unknown> = {
          markdown: record.markdown,
          author_id: record.author_id,
          modified_at: record.modified_at,
          payload: record.payload,
        };
        if (record.embedding) {
          updates.embedding = record.embedding;
        }
        await updateDocument(supabase, node.id, updates, options.dryRun);
        updated += 1;
      }
    }
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleepMs(options.delayMs);
  }

  return { inserted, updated, skipped };
}

async function processPullRequests(params: {
  octokit: InstanceType<typeof Octokit>;
  supabase: ReturnType<typeof createClient<Database>>;
  repoInfo: RepoInfo;
  existing: Map<string, ExistingDoc>;
  options: CliOptions;
  voyageEmbedding: VoyageEmbedding | null;
}): Promise<{ inserted: number; updated: number; skipped: number }> {
  const { octokit, supabase, repoInfo, existing, options, voyageEmbedding } = params;
  let cursor: string | null = null;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let processed = 0;
  const repoPayload = buildRepoPayload(repoInfo);
  const isPrivate = repoInfo.private;

  while (true) {
    const { nodes, pageInfo } = await fetchPullPage(octokit, repoInfo.owner.login, repoInfo.name, cursor);
    for (const node of nodes) {
      if (options.limit && processed >= options.limit) return { inserted, updated, skipped };
      processed += 1;

      const updatedAt = node.updatedAt;
      if (options.since && Number.isFinite(options.since) && Date.parse(updatedAt) < options.since) {
        skipped += 1;
        continue;
      }

      const existingKey = `pull_request:${node.id}`;
      const existingEntry = existing.get(existingKey);
      const shouldProcess = shouldProcessRecord(existingEntry, updatedAt, options.updateExisting);
      if (!shouldProcess) {
        skipped += 1;
        continue;
      }

      const isHuman = isHumanAuthor(node.author);
      const authorId = isHuman && node.author?.databaseId ? node.author.databaseId : -1;
      const rawMarkdown = buildPullRequestMarkdown({ title: node.title ?? "", body: node.body ?? "" }) ?? "";
      const cleaned = cleanMarkdown(rawMarkdown);
      const isShort = isTooShort(cleaned, MIN_ISSUE_MARKDOWN_LENGTH);
      const storedMarkdown = !isShort ? rawMarkdown : null;

      let embedding: number[] | null = null;
      if (options.withEmbeddings && voyageEmbedding && !isPrivate && isHuman && storedMarkdown) {
        embedding = await voyageEmbedding.createEmbedding(cleaned);
      }

      const payload = isPrivate ? null : buildPullRequestPayload(node, repoPayload);
      const record = {
        id: node.id,
        doc_type: "pull_request",
        parent_id: null,
        markdown: isPrivate ? null : storedMarkdown,
        embedding: embedding ? JSON.stringify(embedding) : null,
        author_id: authorId,
        modified_at: node.updatedAt,
        payload,
      };

      if (!existingEntry) {
        await upsertDocument(supabase, record, options.dryRun);
        inserted += 1;
      } else {
        const updates: Record<string, unknown> = {
          markdown: record.markdown,
          author_id: record.author_id,
          modified_at: record.modified_at,
          payload: record.payload,
        };
        if (record.embedding) {
          updates.embedding = record.embedding;
        }
        await updateDocument(supabase, node.id, updates, options.dryRun);
        updated += 1;
      }
    }
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleepMs(options.delayMs);
  }

  return { inserted, updated, skipped };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.repos.length === 0 && options.orgs.length === 0) {
    console.error("Provide at least one --repo or --org.");
    printUsage();
    process.exit(1);
  }

  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_PAT;
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN/GH_TOKEN or pass --token.");
    process.exit(1);
  }

  const supabaseUrl = resolveSupabaseUrl();
  const supabaseKey = resolveSupabaseKey();
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_*_KEY.");
    process.exit(1);
  }

  if (options.withEmbeddings && !process.env.VOYAGEAI_API_KEY) {
    console.error("Missing VOYAGEAI_API_KEY for --with-embeddings.");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });
  const supabase = createClient<Database>(supabaseUrl, supabaseKey);
  const context = { logger: console } as unknown as Context;
  const voyageEmbedding = options.withEmbeddings ? new VoyageEmbedding(new VoyageAIClient({ apiKey: process.env.VOYAGEAI_API_KEY ?? "" }), context) : null;

  const repoSet = new Set<string>();
  for (const repo of options.repos) {
    const normalized = normalizeRepo(repo);
    if (normalized) repoSet.add(normalized);
  }

  for (const org of options.orgs) {
    const normalized = org.trim();
    if (!normalized) continue;
    const orgRepos = await listReposForOrg(octokit, normalized);
    for (const repo of orgRepos) repoSet.add(repo);
  }

  const repos = Array.from(repoSet);
  if (repos.length === 0) {
    console.error("No valid repos resolved.");
    process.exit(1);
  }

  const existing = await loadExistingDocs(supabase, Array.from(options.types), repoSet);

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      console.warn(`Skipping invalid repo: ${repoFullName}`);
      continue;
    }
    console.log(`\n==> ${repoFullName}`);
    const repoInfo = await fetchRepoInfo(octokit, owner, repo);
    const repoExisting = existing.byRepo.get(repoFullName) ?? new Map<string, ExistingDoc>();
    const mergedExisting = new Map<string, ExistingDoc>([...existing.byId, ...repoExisting]);

    if (options.types.has("issue")) {
      const stats = await processIssues({
        octokit,
        supabase,
        repoInfo,
        existing: mergedExisting,
        options,
        voyageEmbedding,
      });
      console.log(`Issues: inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skipped}`);
    }

    if (options.types.has("pull_request")) {
      const stats = await processPullRequests({
        octokit,
        supabase,
        repoInfo,
        existing: mergedExisting,
        options,
        voyageEmbedding,
      });
      console.log(`PRs: inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skipped}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
