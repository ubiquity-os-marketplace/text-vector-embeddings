import { Context } from "../types/index";

export async function deleteReviewComment(context: Context<"pull_request_review_comment.deleted">) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const nodeId = payload.comment.node_id;
  if (payload.comment.user?.type !== "User") {
    logger.debug("Deleting review comment from non-human author", { author: payload.comment.user?.login, type: payload.comment.user?.type });
  }

  try {
    await supabase.comment.deleteComment(nodeId);
    logger.ok(`Successfully deleted review comment! ${payload.comment.id}`, payload.comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error deleting review comment", { error, stack: error.stack, comment: payload.comment });
      throw error;
    } else {
      logger.error("Error deleting review comment", { err: error, comment: payload.comment });
      throw error;
    }
  }
  logger.debug("Exiting deleteReviewComment");
}
