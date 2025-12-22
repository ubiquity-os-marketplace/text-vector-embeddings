import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";
import { removeAnnotateFootnotes } from "./annotate";
import { ensurePullRequestIssue } from "./pull-request-review-utils";

export async function addReviewComment(context: Context<"pull_request_review_comment.created">) {
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
    logger.debug("Ignoring review comment from non-human author", { author: comment.user?.login, type: comment.user?.type });
    return;
  }

  try {
    if (!markdown) {
      logger.error("Review comment body is empty", { comment });
      return;
    }
    if (!pullRequest) {
      logger.error("Pull request payload missing; cannot store review comment", { commentId: comment.id });
      return;
    }

    const issueId = await ensurePullRequestIssue(context, pullRequest);
    const cleanComment = removeAnnotateFootnotes(markdown);

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping review comment storage", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    const queueSettings = getEmbeddingQueueSettings(context.env);
    await supabase.comment.createComment(
      { markdown: cleanComment, id, author_id: authorId, payload, isPrivate, issue_id: issueId ?? null },
      { deferEmbedding: queueSettings.enabled }
    );
    logger.ok("Successfully created review comment", comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating review comment", { error, stack: error.stack, comment });
    } else {
      logger.error("Error creating review comment", { err: error, comment });
    }
  }

  logger.debug("Exiting addReviewComment");
}
