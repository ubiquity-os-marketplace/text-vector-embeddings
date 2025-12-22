import { isHumanUser } from "../helpers/plugin-utils";
import { Context } from "../types/index";
import { removeAnnotateFootnotes } from "./annotate";
import { ensurePullRequestIssue } from "./pull-request-review-utils";

export async function updateReviewComment(context: Context<"pull_request_review_comment.edited">) {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;
  const comment = payload.comment;
  const markdown = comment.body;
  const authorId = comment.user?.id || -1;
  const id = comment.node_id;
  const isPrivate = payload.repository.private;

  try {
    if (!isHumanUser(comment.user)) {
      logger.info("Skipping non-human review comment update", { commentId: comment.id, author: comment.user?.login });
      return;
    }
    if (!markdown) {
      logger.error("Review comment body is empty");
      return;
    }

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping review comment update", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    const issueId = await ensurePullRequestIssue(context);
    if (!issueId) {
      logger.warn("Unable to resolve parent pull request for review comment; skipping update", { commentId: comment.id });
      return;
    }

    const cleanedComment = removeAnnotateFootnotes(markdown);

    await supabase.comment.updateComment({
      markdown: cleanedComment,
      id,
      author_id: authorId,
      payload,
      isPrivate,
      issue_id: issueId,
    });
    logger.ok("Successfully updated review comment", { commentId: comment.id });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error updating review comment", { error, stack: error.stack, comment });
      throw error;
    } else {
      logger.error("Error updating review comment", { err: error, comment });
      throw error;
    }
  }

  logger.debug("Exiting updateReviewComment");
}
