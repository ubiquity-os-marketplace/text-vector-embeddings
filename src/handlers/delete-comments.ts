import { Context } from "../types/index";

export async function deleteComment(context: Context<"issue_comment.deleted">) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const nodeId = payload.comment.node_id;
  if (payload.comment.user?.type !== "User") {
    logger.debug("Comment is from non-human author; proceeding with deletion", {
      author: payload.comment.user?.login,
      type: payload.comment.user?.type,
    });
  }

  try {
    await supabase.comment.deleteComment(nodeId);
    logger.ok(`Successfully deleted comment! ${payload.comment.id}`, payload.comment);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error deleting comment:`, { error: error, stack: error.stack, comment: payload.comment });
      throw error;
    } else {
      logger.error(`Error deleting comment:`, { err: error, error: new Error(), comment: payload.comment });
      throw error;
    }
  }
  logger.debug(`Exiting deleteComments`);
}
