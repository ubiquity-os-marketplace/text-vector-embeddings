import { describe, expect, it } from "bun:test";
import { buildPullRequestReviewMarkdown, buildReviewCommentMarkdown, formatReviewThreadContext } from "../src/handlers/pull-request-review-utils";

describe("buildReviewCommentMarkdown", () => {
  it("appends diff context when a diff hunk is present", () => {
    const result = buildReviewCommentMarkdown({
      body: "Looks good overall.",
      diff_hunk: "@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;",
      path: "src/app.ts",
      line: 12,
    });

    expect(result).toContain("Looks good overall.");
    expect(result).toContain("File: src/app.ts");
    expect(result).toContain("Line: 12");
    expect(result).toContain("```diff");
    expect(result).toContain("+const value = 2;");
  });

  it("returns the body when no diff hunk is present", () => {
    const result = buildReviewCommentMarkdown({ body: "Plain review comment." });

    expect(result).toBe("Plain review comment.");
  });

  it("returns null when the body is empty", () => {
    const result = buildReviewCommentMarkdown({ body: "   ", diff_hunk: "@@ -1 +1 @@" });

    expect(result).toBeNull();
  });
});

describe("buildPullRequestReviewMarkdown", () => {
  it("combines review body, state, and PR title", () => {
    const result = buildPullRequestReviewMarkdown({ body: "Ship it.", state: "approved" }, { title: "Add embeddings", body: "Details here" });

    expect(result).toContain("Ship it.");
    expect(result).toContain("Review state: approved");
    expect(result).toContain("PR title: Add embeddings");
  });

  it("returns null when review content is empty and no metadata exists", () => {
    const result = buildPullRequestReviewMarkdown({ body: "   ", state: "" }, null);

    expect(result).toBeNull();
  });
});

describe("formatReviewThreadContext", () => {
  it("adds a reply header and separator", () => {
    const result = formatReviewThreadContext("Child comment", "Parent context", "alice");

    expect(result).toContain("Child comment");
    expect(result).toContain("In reply to alice:");
    expect(result).toContain("Parent context");
    expect(result).toContain("---");
  });
});
