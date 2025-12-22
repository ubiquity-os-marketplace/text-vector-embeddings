import { Context } from "../types/index";
import { cleanContent } from "./issue-deduplication";

function buildPullRequestMarkdown(pullRequest: { body?: string | null; title?: string | null }): string {
  const body = typeof pullRequest.body === "string" ? pullRequest.body.trim() : "";
  const title = typeof pullRequest.title === "string" ? pullRequest.title.trim() : "";
  if (body && title) return `${body} ${title}`.trim();
  return body || title;
}

export async function ensurePullRequestIssue(
  context: Context<"pull_request_review_comment.created" | "pull_request_review_comment.edited">
): Promise<string | null> {
  const pullRequest = context.payload.pull_request;
  const issueId = typeof pullRequest?.node_id === "string" ? pullRequest.node_id : "";
  if (!issueId) {
    context.logger.error("Pull request node_id is missing; cannot link review comment to issue row", { pullRequestId: pullRequest?.id });
    return null;
  }

  const existing = await context.adapters.supabase.issue.getIssue(issueId);
  if (existing && existing.length > 0) return issueId;

  const markdown = buildPullRequestMarkdown(pullRequest);
  if (!markdown) {
    context.logger.error("Pull request body/title is empty; cannot create issue row", { pullRequestId: pullRequest?.id });
    return null;
  }

  const cleanedIssue = await cleanContent(context, markdown);
  const authorId = pullRequest.user?.id || -1;
  const payload = {
    repository: context.payload.repository,
    issue: pullRequest,
    sender: context.payload.sender,
  };

  await context.adapters.supabase.issue.createIssue({
    id: issueId,
    payload,
    isPrivate: context.payload.repository.private,
    markdown: cleanedIssue,
    author_id: authorId,
  });

  return issueId;
}
