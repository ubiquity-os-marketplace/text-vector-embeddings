import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Context as HonoContext } from "hono";

const routePath = "../src/routes/recommendations";

type MatchResult = {
  matchResultArray: Record<string, string[]>;
  similarIssues: Array<{ id: string; issue_id: string; similarity: number }>;
  sortedContributors: Array<{ login: string; matches: string[]; maxSimilarity: number }>;
};

type SetupOptions = {
  env?: Record<string, string | undefined>;
  issueMatchingResult?: MatchResult;
};

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

async function setupRoute(options: SetupOptions = {}) {
  const envMock = mock(() => ({
    LOG_LEVEL: "debug",
    KERNEL_PUBLIC_KEY: "kernel",
    ...options.env,
  }));
  const issueMatchingMock = mock(async () => options.issueMatchingResult ?? createMatchResult());
  const initAdaptersMock = mock(async () => ({}));
  const issuesGetMock = mock(async () => ({ data: { id: "issue", number: 7, title: "Issue", body: "body" } }));
  const customOctokitCtorMock = mock(() => undefined);
  class CustomOctokitMock {
    rest = { issues: { get: issuesGetMock } };
    constructor() {
      customOctokitCtorMock();
      return this;
    }
  }
  const octokitInstance = { rest: { issues: { get: issuesGetMock } } };
  const getAuthenticatedOctokitMock = mock(async () => octokitInstance);

  await mock.module("hono/adapter", () => ({ env: envMock }));
  await mock.module("../src/cron/workflow", () => ({ getAuthenticatedOctokit: getAuthenticatedOctokitMock }));
  await mock.module("../src/handlers/issue-matching", () => ({ issueMatching: issueMatchingMock }));
  await mock.module("../src/plugin", () => ({ initAdapters: initAdaptersMock }));
  await mock.module("@ubiquity-os/plugin-sdk", () => ({ CommentHandler: class {} }));
  await mock.module("@ubiquity-os/plugin-sdk/octokit", () => ({ customOctokit: CustomOctokitMock }));

  const module = await import(`${routePath}?t=${Date.now()}`);

  return {
    recommendationsRoute: module.recommendationsRoute,
    mocks: {
      envMock,
      issueMatchingMock,
      initAdaptersMock,
      issuesGetMock,
      customOctokitCtorMock,
      getAuthenticatedOctokitMock,
    },
  };
}

describe("/recommendations route", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns issue matching results when app credentials are provided", async () => {
    const matchResult: MatchResult = {
      matchResultArray: { "foo/bar": ["text"] },
      similarIssues: [{ id: "10", issue_id: "20", similarity: 0.92 }],
      sortedContributors: [{ login: "octokit", matches: ["text"], maxSimilarity: 0.92 }],
    };
    const { recommendationsRoute, mocks } = await setupRoute({
      env: { APP_ID: "123", APP_PRIVATE_KEY: "key" },
      issueMatchingResult: matchResult,
    });
    const url = "https://github.com/foo/bar/issues/42";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(mocks.getAuthenticatedOctokitMock).toHaveBeenCalledWith({ appId: "123", appPrivateKey: "key", owner: "foo", repo: "bar" });
    expect(mocks.customOctokitCtorMock).not.toHaveBeenCalled();
    expect(mocks.issuesGetMock).toHaveBeenCalledWith({ owner: "foo", repo: "bar", issue_number: 42 });
  });

  it("uses the default Octokit instance when credentials are missing", async () => {
    const matchResult: MatchResult = {
      matchResultArray: { "foo/bar": ["text"] },
      similarIssues: [],
      sortedContributors: [],
    };
    const { recommendationsRoute, mocks } = await setupRoute({ issueMatchingResult: matchResult });
    const url = "https://github.com/foo/bar/issues/99";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(mocks.customOctokitCtorMock).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthenticatedOctokitMock).not.toHaveBeenCalled();
  });

  it("returns null results for invalid GitHub URLs", async () => {
    const { recommendationsRoute, mocks } = await setupRoute();
    const invalidUrl = "https://example.com/not-a-github-issue";
    const response = await recommendationsRoute(createContext([invalidUrl]));
    const payload = await response.json();

    expect(payload).toEqual({ [invalidUrl]: null });
    expect(mocks.issueMatchingMock).not.toHaveBeenCalled();
    expect(mocks.envMock).not.toHaveBeenCalled();
  });
});
