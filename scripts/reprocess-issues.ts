import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { LOG_LEVEL, LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { createReprocessClients, createReprocessContext, decodeConfig, decodeEnv, reprocessIssue } from "../src/cron/reprocess";
import type { Context } from "../src/types/index";

interface CliOptions {
  repo: string;
  issues: number[];
  token?: string;
  dryRun: boolean;
  skipUpdate: boolean;
  skipMatching: boolean;
  skipDedupe: boolean;
  keepUpdateComment: boolean;
  logLevel?: string;
  delayMs: number;
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/reprocess-issues.ts --repo <owner/repo> --issue 1,2 [options]

Options:
  --repo                Required. Repository in owner/repo format.
  --issue               Comma-separated issue numbers. Can be provided multiple times.
  --skip-update         Skip updating embeddings in Supabase.
  --skip-matching       Skip contributor matching comments.
  --skip-dedupe         Skip duplicate annotation updates.
  --keep-update-comment Keep legacy update markers in the issue body.
  --dry-run             Fetch issues but do not update GitHub/Supabase.
  --log-level           Log level override (default: env LOG_LEVEL or info).
  --delay-ms            Sleep between issues (useful for API rate limits).
  --token               GitHub token override (default: GITHUB_TOKEN/GH_TOKEN).
  --help                Show this help.

Env:
  SUPABASE_URL, SUPABASE_KEY, VOYAGEAI_API_KEY, and a GitHub token.`);
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
    dryRun: false,
    skipUpdate: false,
    skipMatching: false,
    skipDedupe: false,
    keepUpdateComment: false,
    delayMs: 0,
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
      case "--skip-update":
        options.skipUpdate = true;
        break;
      case "--skip-matching":
        options.skipMatching = true;
        break;
      case "--skip-dedupe":
        options.skipDedupe = true;
        break;
      case "--keep-update-comment":
        options.keepUpdateComment = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--log-level":
        options.logLevel = argv[index + 1];
        index += 1;
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

  const env = decodeEnv(process.env);
  const config = decodeConfig();
  const logger = new Logs(
    (options.logLevel as LogLevel) ?? ((process.env.LOG_LEVEL as LogLevel) || LOG_LEVEL.INFO)
  ) as unknown as Context<"issues.edited">["logger"];
  const octokit = new customOctokit({ auth: token });
  const clients = createReprocessClients(env);
  const repoResponse = await octokit.rest.repos.get({ owner, repo });
  const repository = repoResponse.data;

  const issueNumbers = Array.from(new Set(options.issues));
  let processed = 0;

  for (let index = 0; index < issueNumbers.length; index += 1) {
    const issueNumber = issueNumbers[index];
    try {
      const issueResponse = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      const issue = issueResponse.data;

      if (issue.pull_request) {
        console.log(`Skipping PR #${issueNumber}`);
        continue;
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would reprocess #${issueNumber}`);
        processed += 1;
        continue;
      }

      const context = await createReprocessContext({
        issue: issue as unknown as Context<"issues.edited">["payload"]["issue"],
        repository: repository as unknown as Context<"issues.edited">["payload"]["repository"],
        octokit,
        env,
        config,
        logger,
        clients,
      });

      await reprocessIssue(context, {
        updateIssue: !options.skipUpdate,
        runMatching: !options.skipMatching,
        runDedupe: !options.skipDedupe,
        keepUpdateComment: options.keepUpdateComment,
      });

      console.log(`Reprocessed #${issueNumber}`);
      processed += 1;
    } catch (error) {
      console.error(`Failed to reprocess #${issueNumber}`, error);
    }
    if (options.delayMs > 0 && index < issueNumbers.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  console.log(`Done. Processed: ${processed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
