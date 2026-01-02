import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Context as HonoContext } from "hono";

import * as honoAdapter from "hono/adapter";
import * as workflow from "../src/cron/workflow";
import * as issueMatchingModule from "../src/handlers/issue-matching";
import * as githubHelpers from "../src/helpers/github";
import * as initAdaptersModule from "../src/helpers/init-adapters";
import { recommendationsRoute } from "../src/routes/recommendations";

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

function createContext(urls: string[], users: string[] = []): HonoContext {
  return {
    req: {
      queries: (key: string) => {
        if (key === "issueUrls") {
          return urls;
        }
        if (key === "users") {
          return users;
        }
        return [];
      },
    },
  } as unknown as HonoContext;
}

function setupSpies(options: SetupOptions = {}) {
  const envValue = {
    LOG_LEVEL: "debug",
    KERNEL_PUBLIC_KEY: "kernel",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "supabase-key",
    VOYAGEAI_API_KEY: "voyage",
    DENO_KV_URL: "https://kv.example",
    OPENROUTER_API_KEY: "openrouter-key",
    APP_ID: "",
    APP_PRIVATE_KEY: "",
    ...options.env,
  };

  const issuesGetMock = mock(async () => ({ data: { id: "issue", number: 7, title: "Issue", body: "body" } }));
  const octokitInstance = { rest: { issues: { get: issuesGetMock } } };

  const envSpy = spyOn(honoAdapter, "env").mockReturnValue(envValue as never);
  const parseSpy = spyOn(githubHelpers, "parseGitHubUrl").mockImplementation((url: string) => {
    const match = url.match(/^https:\/\/github\.com\/(.+?)\/(.+?)\/issues\/(\d+)/);
    if (!match) {
      throw new Error("Invalid GitHub URL");
    }
    return { owner: match[1], repo: match[2], issue_number: Number(match[3]) } as never;
  });
  const initAdaptersSpy = spyOn(initAdaptersModule, "initAdapters").mockResolvedValue({} as never);
  const issueMatchingSpy = spyOn(issueMatchingModule, "issueMatching").mockResolvedValue((options.issueMatchingResult ?? createMatchResult()) as never);
  const issueMatchingForUsersSpy = spyOn(issueMatchingModule, "issueMatchingForUsers").mockResolvedValue(
    (options.issueMatchingResult ?? createMatchResult()) as never
  );
  const getAuthenticatedOctokitSpy = spyOn(workflow, "getAuthenticatedOctokit").mockResolvedValue(octokitInstance as never);

  return {
    envSpy,
    parseSpy,
    initAdaptersSpy,
    issueMatchingSpy,
    issueMatchingForUsersSpy,
    getAuthenticatedOctokitSpy,
    issuesGetMock,
    octokitInstance,
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
    const spies = setupSpies({
      env: { APP_ID: "123", APP_PRIVATE_KEY: "key" },
      issueMatchingResult: matchResult,
    });
    const url = "https://github.com/foo/bar/issues/42";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(spies.getAuthenticatedOctokitSpy).toHaveBeenCalledWith({ appId: "123", appPrivateKey: "key", owner: "foo", repo: "bar" });
    expect(spies.issuesGetMock).toHaveBeenCalledWith({ owner: "foo", repo: "bar", issue_number: 42 });
  });

  it("uses the default Octokit instance when credentials are missing", async () => {
    const matchResult: MatchResult = {
      matchResultArray: { "foo/bar": ["text"] },
      similarIssues: [],
      sortedContributors: [],
    };
    const spies = setupSpies({ issueMatchingResult: matchResult });
    // @ts-expect-error overrides for fetch
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      let requestUrl: string;
      if (typeof input === "string") {
        requestUrl = input;
      } else if (input instanceof URL) {
        requestUrl = input.toString();
      } else {
        requestUrl = input.url;
      }

      if (requestUrl.includes("/repos/foo/bar/issues/99")) {
        return new Response(JSON.stringify({ id: "issue", number: 99, title: "Issue", body: "body" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const url = "https://github.com/foo/bar/issues/99";
    const response = await recommendationsRoute(createContext([url]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(spies.getAuthenticatedOctokitSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("returns a result for every requested user", async () => {
    const matchResult: MatchResult = {
      matchResultArray: {
        alice: ["> `80% Match` [foo/bar#1](https://www.github.com/foo/bar/issues/1)"],
        bob: [],
      },
      similarIssues: [{ id: "10", issue_id: "20", similarity: 0.8 }],
      sortedContributors: [
        { login: "alice", matches: ["> `80% Match` [foo/bar#1](https://www.github.com/foo/bar/issues/1)"], maxSimilarity: 80 },
        { login: "bob", matches: [], maxSimilarity: 0 },
      ],
    };
    const spies = setupSpies({ env: { APP_ID: "123", APP_PRIVATE_KEY: "key" }, issueMatchingResult: matchResult });
    const url = "https://github.com/foo/bar/issues/42";

    const response = await recommendationsRoute(createContext([url], ["alice", "bob"]));
    const payload = await response.json();

    expect(payload).toEqual({ [url]: matchResult });
    expect(spies.issueMatchingForUsersSpy).toHaveBeenCalledTimes(1);
    expect(spies.issueMatchingSpy).not.toHaveBeenCalled();
  });

  it("returns null results for invalid GitHub URLs", async () => {
    const spies = setupSpies();
    spies.parseSpy.mockImplementationOnce(() => {
      throw new Error("Invalid GitHub URL");
    });
    const invalidUrl = "https://example.com/not-a-github-issue";
    const response = await recommendationsRoute(createContext([invalidUrl]));
    const payload = await response.json();

    expect(payload).toEqual({ [invalidUrl]: null });
    expect(spies.issueMatchingSpy).not.toHaveBeenCalled();
    expect(spies.issueMatchingForUsersSpy).not.toHaveBeenCalled();
    expect(spies.envSpy).toHaveBeenCalledTimes(1);
  });
});
