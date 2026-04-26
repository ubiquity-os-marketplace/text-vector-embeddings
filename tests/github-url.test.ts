import { describe, expect, it } from "bun:test";
import { normalizeGitHubCommentUrl, normalizeGitHubIssueUrl } from "../src/utils/github-url";

describe("normalizeGitHubIssueUrl", () => {
  it("strips hash fragments before converting to the www.github.com domain", () => {
    expect(normalizeGitHubIssueUrl("https://github.com/acme/project/issues/12#issuecomment-12345")).toBe("https://www.github.com/acme/project/issues/12");
  });

  it("preserves plain issue URLs while normalizing the domain", () => {
    expect(normalizeGitHubIssueUrl("https://github.com/acme/project/issues/12")).toBe("https://www.github.com/acme/project/issues/12");
  });
});

describe("normalizeGitHubCommentUrl", () => {
  it("preserves hash fragments for comment links while normalizing the domain", () => {
    expect(normalizeGitHubCommentUrl("https://github.com/acme/project/issues/12#issuecomment-12345")).toBe(
      "https://www.github.com/acme/project/issues/12#issuecomment-12345"
    );
  });
});
