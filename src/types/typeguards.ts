import { Context } from "./context";

/**
 * Typeguards are most helpful when you have a union type and you want to narrow it down to a specific one.
 * In other words, if `SupportedEvents` has multiple types then these restrict the scope
 * of `context` to a specific event payload.
 */

/**
 * Restricts the scope of `context` to the `issue_comment.created`, `issue_comment.deleted`, and `issue_comment.edited` payloads.
 *
 * @param context The context object.
 */
export function isIssueCommentEvent(context: Context): context is Context<"issue_comment.created" | "issue_comment.deleted" | "issue_comment.edited"> {
  return context.eventName === "issue_comment.created" || context.eventName === "issue_comment.deleted" || context.eventName === "issue_comment.edited";
}

/**
 * Restricts the scope of `context` to the `pull_request_review_comment.created`, `pull_request_review_comment.edited`,
 * and `pull_request_review_comment.deleted` payloads.
 *
 * @param context The context object.
 */
export function isPullRequestReviewCommentEvent(
  context: Context
): context is Context<"pull_request_review_comment.created" | "pull_request_review_comment.edited" | "pull_request_review_comment.deleted"> {
  return (
    context.eventName === "pull_request_review_comment.created" ||
    context.eventName === "pull_request_review_comment.edited" ||
    context.eventName === "pull_request_review_comment.deleted"
  );
}

/**
 * Restricts the scope of `context` to the `pull_request_review.submitted` and `pull_request_review.edited` payloads.
 *
 * @param context The context object.
 */
export function isPullRequestReviewEvent(context: Context): context is Context<"pull_request_review.submitted" | "pull_request_review.edited"> {
  return context.eventName === "pull_request_review.submitted" || context.eventName === "pull_request_review.edited";
}

/**
 * Restricts the scope of `context` to the `pull_request.opened` and `pull_request.edited` payloads.
 *
 * @param context The context object.
 */
export function isPullRequestEvent(context: Context): context is Context<"pull_request.opened" | "pull_request.edited"> {
  return context.eventName === "pull_request.opened" || context.eventName === "pull_request.edited";
}

/**
 * Restricts the scope of `context` to the `issues.opened`, `issues.edited`, `issues.deleted`, `issues.transferred`, and `issues.closed` payloads.
 *
 * @param context The context object.
 */
export function isIssueEvent(
  context: Context
): context is Context<"issues.opened" | "issues.edited" | "issues.deleted" | "issues.transferred" | "issues.closed"> {
  return (
    context.eventName === "issues.opened" ||
    context.eventName === "issues.edited" ||
    context.eventName === "issues.deleted" ||
    context.eventName === "issues.transferred" ||
    context.eventName === "issues.closed"
  );
}
