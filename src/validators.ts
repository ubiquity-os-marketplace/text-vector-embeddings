import * as v from "valibot";

const GITHUB_ISSUE_OR_PULL_URL_REGEX = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+\/?$/;

export const urlSchema = v.pipe(
  v.string(),
  v.url("Expected a valid URL."),
  v.regex(GITHUB_ISSUE_OR_PULL_URL_REGEX, "Expected a GitHub issue or pull request URL, e.g. https://github.com/owner/repo/issues/123.")
);

export const querySchema = v.object({
  issueUrls: v.union([v.array(urlSchema), urlSchema]),
  users: v.optional(v.union([v.array(v.string()), v.string()])),
});

export const responseSchema = v.record(
  v.string(),
  v.union([
    v.object({
      matchResultArray: v.record(v.string(), v.array(v.string())),
      similarIssues: v.array(
        v.object({
          id: v.string(),
          issue_id: v.string(),
          similarity: v.number(),
        })
      ),
      sortedContributors: v.array(
        v.object({
          login: v.string(),
          matches: v.array(v.string()),
          maxSimilarity: v.number(),
        })
      ),
    }),
    v.null(),
  ])
);
