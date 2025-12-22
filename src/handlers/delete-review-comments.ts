import { Context } from "../types/index";

export async function deleteReviewComment(context: Context<"pull_request_review_comment.deleted">) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const nodeId = payload.comment.node_id;

  try {
    await supabase.comment.deleteComment(nodeId);
    logger.ok("Successfully deleted review comment", { commentId: payload.comment.id });
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
