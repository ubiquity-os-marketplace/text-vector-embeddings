import { Context } from "../types";
import { annotate } from "./annotate";

export async function commandHandler(context: Context) {
  const { logger } = context;

  if (context.eventName !== "issue_comment.created") {
    return;
  }

  if (!context.command) {
    return;
  }

  if (context.command.name === "annotate") {
    const commentUrl = context.command.parameters.commentUrl ?? null;
    const scope = context.command.parameters.scope ?? "org";
    let commentId = null;
    if (commentUrl) {
      const commentRegex = /#issuecomment-(\d+)$/;
      const match = commentUrl.match(commentRegex);
      if (!match) {
        throw logger.error("Invalid comment URL");
      }
      commentId = match[1];
    }
    await annotate(context, commentId, scope);
  }
}

export async function userAnnotate(context: Context<"issue_comment.created">) {
  const { logger } = context;
  const comment = context.payload.comment;
  const splitComment = comment.body.trim().split(" ");
  const commandName = splitComment[0].replace("/", "");

  let commentId = null;
  let scope = "org";

  if (commandName === "annotate") {
    if (splitComment.length > 1) {
      if (splitComment.length === 3) {
        const commentUrl = splitComment[1];
        scope = splitComment[2];

        if (scope !== "global" && scope !== "org" && scope !== "repo") {
          throw logger.error("Invalid scope");
        }

        const commentRegex = /#issuecomment-(\d+)$/;
        const match = commentUrl.match(commentRegex);
        if (!match) {
          throw logger.error("Invalid comment URL");
        }
        commentId = match[1];
      } else {
        throw logger.error("Invalid parameters");
      }
    }
    await annotate(context, commentId, scope);
  }
}
