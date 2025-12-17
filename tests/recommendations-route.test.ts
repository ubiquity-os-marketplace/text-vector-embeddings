import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Context as HonoContext } from "hono";
import { createRecommendationsRoute } from "../src/routes/recommendations";
import type { Context, Env } from "../src/types/index";

type MatchResult = {
  matchResultArray: Record<string, string[]>;
  similarIssues: Array<{ id: string; issue_id: string; similarity: number }>;
  sortedContributors: Array<{ login: string; matches: string[]; maxSimilarity: number }>;
};

type SetupOptions = {
  env?: Record<string, string | undefined>;
  issueMatchingResult?: MatchResult;
};

type IssueOpenedContext = Context<"issues.opened">;
type OctokitConstructor = (typeof import("@ubiquity-os/plugin-sdk/octokit"))["customOctokit"];
type OctokitInstance = InstanceType<OctokitConstructor>;
type GetAuthenticatedOctokitArgs = Parameters<(typeof import("../src/cron/workflow"))["getAuthenticatedOctokit"]>[0];

function createMatchResult(): MatchResult {
  return {
    matchResultArray: { "foo/bar": ["body"] },
    similarIssues: [{ id: "2", issue_id: "1", similarity: 0.9 }],
    sortedContributors: [{ login: "dev", matches: ["body"], maxSimilarity: 0.9 }],
  };
}

function createContext(urls: string[]): HonoContext {
  return {
    req: {
      queries: mock(() => urls),
    },
  } as unknown as HonoContext;
}

function createEnv(overrides?: Record<string, string | undefined>): Env {
  return {
    LOG_LEVEL: "debug",
    KERNEL_PUBLIC_KEY: "kernel",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "supabase-key",
    VOYAGEAI_API_KEY: "voyage",
    DENO_KV_URL: "https://kv.example",
    APP_ID: undefined,
    APP_PRIVATE_KEY: undefined,
    ...overrides,
  };
}

function setupRoute(options: SetupOptions = {}) {
  const getEnv = mock((c: HonoContext) => {
    void c;
    return createEnv(options.env);
  });
  const issueMatchingMock = mock(async (ctx: IssueOpenedContext) => {
    void ctx;
    return options.issueMatchingResult ?? createMatchResult();
  });
  const initAdaptersMock = mock(async (ctx: IssueOpenedContext) => {
    void ctx;
    return {} as unknown as IssueOpenedContext["adapters"];
  });
  const issuesGetMock = mock(async () => ({ data: { id: "issue", number: 7, title: "Issue", body: "body" } }));

  const octokitInstance = { rest: { issues: { get: issuesGetMock } } } as unknown as OctokitInstance;
  const createOctokitMock = mock(() => octokitInstance);
  const getAuthenticatedOctokitMock = mock(async (args: GetAuthenticatedOctokitArgs) => {
    void args;
    return octokitInstance;
  });

  return {
    recommendationsRoute: createRecommendationsRoute({
      getEnv: (c) => getEnv(c),
      createOctokit: () => createOctokitMock(),
      getAuthenticatedOctokit: (args: GetAuthenticatedOctokitArgs) => getAuthenticatedOctokitMock(args),
      initAdapters: (ctx: IssueOpenedContext) => initAdaptersMock(ctx),
      issueMatching: (ctx: IssueOpenedContext) => issueMatchingMock(ctx),
    }),
    mocks: {
      getEnv,
      issueMatchingMock,
      initAdaptersMock,
      issuesGetMock,
      createOctokitMock,
      getAuthenticatedOctokitMock,
    },
  };
}

describe("/recommendations route", () => {
  afterEach(() => {
    mock.restore();
    mock.clearAllMocks();
  });

  it("returns issue matching results when app credentials are provided", async () => {
    const matchResult: MatchResult = {
      matchResultArray: { "foo/bar": ["text"] },
      similarIssues: [{ id: "10", issue_id: "20", similarity: 0.92 }],
      sortedContributors: [{ login: "octokit", matches: ["text"], maxSimilarity: 0.92 }],
    };
    const { recommendationsRoute, mocks } = setupRoute({
      env: { APP_ID: "123", APP_PRIVATE_KEY: "key" },
      issueMatchingResult: matchResult,
    });
    const url = "https://github.com/foo/bar/issues/42";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(mocks.getAuthenticatedOctokitMock).toHaveBeenCalledWith({ appId: "123", appPrivateKey: "key", owner: "foo", repo: "bar" });
    expect(mocks.createOctokitMock).not.toHaveBeenCalled();
    expect(mocks.issuesGetMock).toHaveBeenCalledWith({ owner: "foo", repo: "bar", issue_number: 42 });
  });

  it("uses the default Octokit instance when credentials are missing", async () => {
    const matchResult: MatchResult = {
      matchResultArray: { "foo/bar": ["text"] },
      similarIssues: [],
      sortedContributors: [],
    };
    const { recommendationsRoute, mocks } = setupRoute({ issueMatchingResult: matchResult });
    const url = "https://github.com/foo/bar/issues/99";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(mocks.createOctokitMock).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthenticatedOctokitMock).not.toHaveBeenCalled();
  });

  it("returns null results for invalid GitHub URLs", async () => {
    const { recommendationsRoute, mocks } = setupRoute();
    const invalidUrl = "https://example.com/not-a-github-issue";
    const response = await recommendationsRoute(createContext([invalidUrl]));
    const payload = await response.json();

    expect(payload).toEqual({ [invalidUrl]: null });
    expect(mocks.issueMatchingMock).not.toHaveBeenCalled();
    expect(mocks.getEnv).toHaveBeenCalledTimes(1);
    expect(mocks.createOctokitMock).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedOctokitMock).not.toHaveBeenCalled();
  });
});
