import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
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
  const pullRequest = payload.pull_request;

  if (comment.user?.type !== "User") {
    logger.debug("Ignoring review comment update from non-human author", { author: comment.user?.login, type: comment.user?.type });
    return;
  }

  try {
    if (!markdown) {
      logger.error("Review comment body is empty", { comment });
      return;
    }
    if (!pullRequest) {
      logger.error("Pull request payload missing; cannot update review comment", { commentId: comment.id });
      return;
    }

    const issueId = await ensurePullRequestIssue(context, pullRequest);
    const cleanedComment = removeAnnotateFootnotes(markdown);

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping review comment update in database", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    const queueSettings = getEmbeddingQueueSettings(context.env);
    await supabase.comment.updateComment(
      { markdown: cleanedComment, id, author_id: authorId, payload, isPrivate, issue_id: issueId ?? null },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok("Successfully updated review comment", comment);
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
