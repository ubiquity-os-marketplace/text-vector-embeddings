import { customOctokit } from "@ubiquity-os/plugin-sdk/octokit";
import { appendPluginUpdateComment, normalizeWhitespace, stripPluginUpdateComments } from "../src/utils/markdown-comments";

type IssueState = "open" | "closed" | "all";

interface CliOptions {
  repo: string;
  issues: number[];
  state: IssueState;
  all: boolean;
  keepLatest: boolean;
  dryRun: boolean;
  normalizeWhitespace: boolean;
  limit?: number;
  token?: string;
}

type IssueListItem = {
  number: number;
  pull_request?: unknown;
};

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/cleanup-update-comments.ts --repo <owner/repo> [--issue 1,2] [--all] [--state open|closed|all] [--limit N] [--remove-all] [--dry-run]

Options:
  --repo        Required. Repository in owner/repo format.
  --issue       Comma-separated issue numbers. Can be provided multiple times.
  --all         Scan all issues in the repo (use with --state).
  --state       Issue state for --all (default: all).
  --limit       Max issues to process when using --all.
  --remove-all  Remove all update comments (do not keep the latest).
  --normalize   Collapse repeated blank lines after cleanup.
  --dry-run     Show what would change without updating issues.

Auth:
  Uses GITHUB_TOKEN or GH_TOKEN from the environment unless --token is provided.`);
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
    state: "all",
    all: false,
    keepLatest: true,
    dryRun: false,
    normalizeWhitespace: false,
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
      case "--all":
        options.all = true;
        break;
      case "--state":
        options.state = (argv[index + 1] as IssueState) || "all";
        index += 1;
        break;
      case "--limit":
        options.limit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--remove-all":
        options.keepLatest = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--normalize":
        options.normalizeWhitespace = true;
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

  if (!options.all && options.issues.length === 0) {
    console.error("Provide --issue or --all.");
    printUsage();
    process.exit(1);
  }

  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_PAT;
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN, or pass --token.");
    process.exit(1);
  }

  const [owner, repo] = options.repo.split("/");
  if (!owner || !repo) {
    console.error("Invalid --repo format. Use owner/repo.");
    process.exit(1);
  }

  const octokit = new customOctokit({ auth: token });
  let issueNumbers = Array.from(new Set(options.issues));

  if (options.all) {
    const issues = (await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: options.state,
      per_page: 100,
    })) as IssueListItem[];
    issueNumbers = issues.filter((issue) => !issue.pull_request).map((issue) => issue.number);
    if (options.limit && options.limit > 0) {
      issueNumbers = issueNumbers.slice(0, options.limit);
    }
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const issueNumber of issueNumbers) {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
    const body = data.body ?? "";
    const { cleaned, latestComment, matchCount } = stripPluginUpdateComments(body);

    if (matchCount === 0) {
      skippedCount += 1;
      continue;
    }

    const normalized = options.normalizeWhitespace ? normalizeWhitespace(cleaned) : cleaned;
    const nextBody = options.keepLatest && latestComment ? appendPluginUpdateComment(normalized, latestComment) : normalized.trimEnd();

    if (nextBody === body) {
      skippedCount += 1;
      continue;
    }

    if (options.dryRun) {
      console.log(`[dry-run] Would update issue #${issueNumber}`);
      updatedCount += 1;
      continue;
    }

    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      body: nextBody,
    });
    console.log(`Updated issue #${issueNumber}`);
    updatedCount += 1;
  }

  console.log(`Done. Updated: ${updatedCount}, Skipped: ${skippedCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
