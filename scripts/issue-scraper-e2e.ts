import "dotenv/config";
import { issueScraper } from "../src/handlers/issue-scraper";

type CliOptions = {
  user: string;
  token?: string;
  limit?: number;
  dryRun: boolean;
  skipEmbeddings: boolean;
};

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/issue-scraper-e2e.ts --user <github-login> [options]

Options:
  --user             Required. GitHub username to scan (assignee search).
  --token            GitHub token override (default: GITHUB_TOKEN/GH_TOKEN).
  --limit            Limit number of issues processed.
  --dry-run          Skip database writes.
  --skip-embeddings  Skip VoyageAI embeddings.
  --help             Show this help.

Env:
  SUPABASE_URL, SUPABASE_KEY, VOYAGEAI_API_KEY, and a GitHub token.`);
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    console.error(`Missing value for ${flag}.`);
    printUsage();
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    user: "",
    dryRun: false,
    skipEmbeddings: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--user":
        options.user = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--token":
        options.token = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        const limitValue = readFlagValue(argv, index, arg);
        const parsedLimit = Number(limitValue);
        if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit <= 0) {
          console.error(`Invalid value for ${arg}: ${limitValue}`);
          printUsage();
          process.exit(1);
        }
        options.limit = parsedLimit;
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-embeddings":
        options.skipEmbeddings = true;
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

  if (!options.user) {
    console.error("Missing --user.");
    printUsage();
    process.exit(1);
  }

  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_PAT;
  if (!token) {
    console.error("Missing GitHub token. Set GITHUB_TOKEN/GH_TOKEN or pass --token.");
    process.exit(1);
  }

  if (options.limit && options.limit > 0) {
    process.env.ISSUE_SCRAPER_LIMIT = String(options.limit);
  }
  if (options.dryRun) {
    process.env.ISSUE_SCRAPER_DRY_RUN = "true";
  }
  if (options.skipEmbeddings) {
    process.env.ISSUE_SCRAPER_SKIP_EMBEDDINGS = "true";
  }

  const result = await issueScraper(options.user, token);
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
