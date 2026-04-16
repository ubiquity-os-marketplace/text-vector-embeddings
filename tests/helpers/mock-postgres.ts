import { PostgresClient, PostgresPool, QueryResult } from "../../src/adapters/postgres-driver";

type TrackedIssueRecord = {
  owner: string;
  repo: string;
  issueNumber: number;
};

type RateLimitRecord = {
  totalHits: number;
  resetTime: Date;
};

type MockPostgresState = {
  trackedIssues: Map<string, Set<number>>;
  rateLimitRecords: Map<string, RateLimitRecord>;
  ended: boolean;
  releasedClients: number;
};

function normalizeQuery(query: TemplateStringsArray): string {
  return query.join(" ? ").replace(/\s+/g, " ").trim();
}

function splitRepositoryKey(repositoryKey: string): { owner: string; repo: string } {
  const [owner, repo] = repositoryKey.split("/");
  return { owner, repo };
}

function getTrackedIssueRows(state: MockPostgresState): TrackedIssueRecord[] {
  return Array.from(state.trackedIssues.entries())
    .flatMap(([repositoryKey, issueNumbers]) => {
      const { owner, repo } = splitRepositoryKey(repositoryKey);
      return Array.from(issueNumbers.values()).map((issueNumber) => ({ owner, repo, issueNumber }));
    })
    .sort((left, right) => {
      if (left.owner !== right.owner) {
        return left.owner.localeCompare(right.owner);
      }
      if (left.repo !== right.repo) {
        return left.repo.localeCompare(right.repo);
      }
      return left.issueNumber - right.issueNumber;
    });
}

function createQueryHandler(state: MockPostgresState) {
  return async function queryObject<T>(query: TemplateStringsArray, ...args: unknown[]): Promise<QueryResult<T>> {
    const sql = normalizeQuery(query);

    if (
      sql.startsWith("CREATE TABLE IF NOT EXISTS tracked_issues") ||
      sql.startsWith("CREATE INDEX IF NOT EXISTS tracked_issues_owner_repo_idx") ||
      sql.startsWith("CREATE TABLE IF NOT EXISTS rate_limit_records") ||
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK"
    ) {
      return { rows: [] as T[] };
    }

    if (sql.startsWith("SELECT issue_number FROM tracked_issues")) {
      const owner = String(args[0]);
      const repo = String(args[1]);
      const rows = Array.from(state.trackedIssues.get(`${owner}/${repo}`) ?? [])
        .sort((left, right) => left - right)
        .map((issueNumber) => ({ issue_number: issueNumber }));
      return { rows: rows as T[] };
    }

    if (sql.startsWith("INSERT INTO tracked_issues")) {
      const owner = String(args[0]);
      const repo = String(args[1]);
      const issueNumber = Number(args[2]);
      const repositoryKey = `${owner}/${repo}`;
      const issueNumbers = state.trackedIssues.get(repositoryKey) ?? new Set<number>();
      issueNumbers.add(issueNumber);
      state.trackedIssues.set(repositoryKey, issueNumbers);
      return { rows: [] as T[] };
    }

    if (sql.startsWith("DELETE FROM tracked_issues")) {
      const owner = String(args[0]);
      const repo = String(args[1]);
      const issueNumber = Number(args[2]);
      const repositoryKey = `${owner}/${repo}`;
      const issueNumbers = state.trackedIssues.get(repositoryKey);

      if (issueNumbers) {
        issueNumbers.delete(issueNumber);
        if (issueNumbers.size === 0) {
          state.trackedIssues.delete(repositoryKey);
        }
      }

      return { rows: [] as T[] };
    }

    if (sql.startsWith("SELECT owner, repo, array_agg(issue_number ORDER BY issue_number) AS issue_numbers FROM tracked_issues")) {
      const groupedRows = Array.from(state.trackedIssues.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repositoryKey, issueNumbers]) => {
          const { owner, repo } = splitRepositoryKey(repositoryKey);
          return {
            owner,
            repo,
            issue_numbers: Array.from(issueNumbers.values()).sort((left, right) => left - right),
          };
        });
      return { rows: groupedRows as T[] };
    }

    if (sql.startsWith("SELECT EXISTS (SELECT 1 FROM tracked_issues) AS has_data")) {
      return { rows: [{ has_data: state.trackedIssues.size > 0 }] as T[] };
    }

    if (sql.startsWith("SELECT total_hits, reset_time FROM rate_limit_records")) {
      const key = String(args[0]);
      const record = state.rateLimitRecords.get(key);
      return {
        rows: record ? ([{ total_hits: record.totalHits, reset_time: record.resetTime.toISOString() }] as T[]) : ([] as T[]),
      };
    }

    if (sql.startsWith("DELETE FROM rate_limit_records")) {
      const key = String(args[0]);
      state.rateLimitRecords.delete(key);
      return { rows: [] as T[] };
    }

    if (sql.startsWith("INSERT INTO rate_limit_records")) {
      const key = String(args[0]);
      const totalHits = Number(args[1]);
      const resetTime = new Date(String(args[2]));
      state.rateLimitRecords.set(key, { totalHits, resetTime });
      return { rows: [] as T[] };
    }

    if (sql.startsWith("UPDATE rate_limit_records")) {
      const totalHits = Number(args[0]);
      const resetTime = new Date(String(args[1]));
      const key = String(args[2]);
      if (state.rateLimitRecords.has(key)) {
        state.rateLimitRecords.set(key, { totalHits, resetTime });
      }
      return { rows: [] as T[] };
    }

    throw new Error(`Unhandled mock Postgres query: ${sql}`);
  };
}

export function createMockPostgresPool() {
  const state: MockPostgresState = {
    trackedIssues: new Map(),
    rateLimitRecords: new Map(),
    ended: false,
    releasedClients: 0,
  };

  const queryObject = createQueryHandler(state);

  const client: PostgresClient = {
    queryObject,
    release() {
      state.releasedClients += 1;
    },
  };

  const pool: PostgresPool = {
    async connect() {
      return client;
    },
    async end() {
      state.ended = true;
    },
  };

  return {
    pool,
    state,
    getTrackedIssueRows: () => getTrackedIssueRows(state),
  };
}
