import { isHumanUser } from "../helpers/plugin-utils";
import { Context } from "../types/index";
import { removeAnnotateFootnotes } from "./annotate";
import { ensurePullRequestIssue } from "./pull-request-review-utils";

export async function addReviewComments(context: Context<"pull_request_review_comment.created">) {
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
      logger.info("Skipping non-human review comment", { commentId: comment.id, author: comment.user?.login });
      return;
    }
    if (!markdown) {
      logger.error("Review comment body is empty");
      return;
    }

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping review comment storage", { comment: comment.id, comment_url: comment.html_url });
      return;
    }

    const issueId = await ensurePullRequestIssue(context);
    if (!issueId) {
      logger.warn("Unable to resolve parent pull request for review comment; skipping", { commentId: comment.id });
      return;
    }

    const cleanComment = removeAnnotateFootnotes(markdown);

    await supabase.comment.createComment({
      markdown: cleanComment,
      id,
      author_id: authorId,
      payload,
      isPrivate,
      issue_id: issueId,
    });
    logger.ok("Successfully created review comment", { commentId: comment.id });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating review comment", { error, stack: error.stack, comment });
    } else {
      logger.error("Error creating review comment", { err: error, comment });
    }
  }
  logger.debug("Exiting addReviewComments");
}
