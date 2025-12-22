 
import { createClient } from "@supabase/supabase-js";
import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { Database } from "../src/types/database";

interface CliOptions {
  repo: string;
  issues: number[];
  token?: string;
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/inspect-embeddings.ts --repo <owner/repo> --issue 1,2 [--token <token>]

Env:
  SUPABASE_URL and SUPABASE_KEY must be set.`);
}

function parseIssueList(value: string): number[] {
  return value
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((num) => Number.isFinite(num) && num > 0);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repo: "",
    issues: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        options.repo = argv[index + 1] || "";
        index += 1;
        break;
      case "--issue":
        options.issues.push(...parseIssueList(argv[index + 1] || ""));
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.repo) {
    console.error("Missing --repo.");
    printUsage();
    process.exit(1);
  }

  if (options.issues.length === 0) {
    console.error("Provide at least one --issue.");
    printUsage();
    process.exit(1);
  }

  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_PAT;
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN/GH_TOKEN or pass --token.");
    process.exit(1);
  }

  const [owner, repo] = options.repo.split("/");
  if (!owner || !repo) {
    console.error("Invalid --repo format. Use owner/repo.");
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_KEY.");
    process.exit(1);
  }
  const supabase = createClient<Database>(supabaseUrl, supabaseKey);
  const octokit = new customOctokit({ auth: token });

  const issueNumbers = Array.from(new Set(options.issues));

  for (const issueNumber of issueNumbers) {
    try {
      const issueResponse = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      const issue = issueResponse.data;
      if (issue.pull_request) {
        console.log(`Skipping PR #${issueNumber}`);
        continue;
      }

      const nodeId = issue.node_id;
      const { data, error } = await supabase.from("issues").select("id, plaintext, modified_at, embedding").eq("id", nodeId).limit(1);
      if (error) {
        console.error(`Supabase error for #${issueNumber}`, error);
        continue;
      }

      const record = data?.[0];
      if (!record) {
        console.log(`No Supabase record for #${issueNumber} (${nodeId})`);
        continue;
      }

      const embeddingLength = Array.isArray(record.embedding) ? record.embedding.length : 0;

      console.log(`Issue #${issueNumber}: ${issue.html_url}`);
      console.log(`node_id: ${nodeId}`);
      console.log(`modified_at: ${record.modified_at ?? "unknown"}`);
      console.log(`embedding_length: ${embeddingLength}`);
      console.log("plaintext:");
      console.log(record.plaintext ?? "<null>");
      console.log("---");
    } catch (error) {
      console.error(`Failed to inspect #${issueNumber}`, error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
