import { updateCronState } from "./cron/workflow";
import { addComments } from "./handlers/add-comments";
import { addIssue } from "./handlers/add-issue";
import { completeIssue } from "./handlers/complete-issue";
import { deleteComment } from "./handlers/delete-comments";
import { deleteIssues } from "./handlers/delete-issue";
import { issueDedupe } from "./handlers/issue-deduplication";
import { issueMatchingWithComment } from "./handlers/issue-matching";
import { issueTransfer } from "./handlers/transfer-issue";
import { updateComment } from "./handlers/update-comments";
import { updateIssue } from "./handlers/update-issue";
import { commandHandler, userAnnotate } from "./handlers/user-annotate";
import { initAdapters } from "./helpers/init-adapters";
import { isPluginEdit } from "./helpers/plugin-utils";
import { Context } from "./types/index";
import { isIssueCommentEvent, isIssueEvent } from "./types/typeguards";

/**
 * The main plugin function. Split for easier testing.
 */
export async function runPlugin(context: Context) {
  const { logger, eventName } = context;

  if (!context.adapters?.supabase && !context.adapters?.voyage) {
    context.adapters = await initAdapters(context);
  }

  if (context.command) {
    return await commandHandler(context);
  }

  if (isIssueCommentEvent(context)) {
    switch (eventName) {
      case "issue_comment.created":
        await addComments(context as Context<"issue_comment.created">);
        return await userAnnotate(context as Context<"issue_comment.created">);
      case "issue_comment.deleted":
        return await deleteComment(context as Context<"issue_comment.deleted">);
      case "issue_comment.edited":
        return await updateComment(context as Context<"issue_comment.edited">);
    }
  } else if (isIssueEvent(context)) {
    switch (eventName) {
      case "issues.opened":
        await addIssue(context as Context<"issues.opened">);
        await issueMatchingWithComment(context as Context<"issues.opened">);
        break;
      case "issues.edited":
        if (isPluginEdit(context as Context<"issues.edited">)) {
          logger.info("Plugin edit detected, will run issue matching and checker.");
          await issueMatchingWithComment(context as Context<"issues.edited">);
          await issueDedupe(context as Context<"issues.edited">);
        } else {
          await updateIssue(context as Context<"issues.edited">);
        }
        break;
      case "issues.deleted":
        await deleteIssues(context as Context<"issues.deleted">);
        break;
      case "issues.transferred":
        await issueTransfer(context as Context<"issues.transferred">);
        break;
      case "issues.closed":
        await completeIssue(context as Context<"issues.closed">);
        break;
    }
  } else if (eventName == "issues.labeled") {
    return await issueMatchingWithComment(context as Context<"issues.labeled">);
  } else {
    logger.error(`Unsupported event: ${eventName}`);
    return;
  }
  await updateCronState(context);
  logger.ok(`Exiting plugin`);
}
