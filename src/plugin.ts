import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "./adapters/index";
import { updateCronState } from "./cron/workflow";
import { addComments } from "./handlers/add-comments";
import { addIssue } from "./handlers/add-issue";
import { completeIssue } from "./handlers/complete-issue";
import { deleteComment } from "./handlers/delete-comments";
import { deleteIssues } from "./handlers/delete-issue";
import { issueDedupe } from "./handlers/issue-deduplication";
import { issueMatching } from "./handlers/issue-matching";
import { issueTransfer } from "./handlers/transfer-issue";
import { updateComment } from "./handlers/update-comments";
import { updateIssue } from "./handlers/update-issue";
import { commandHandler, userAnnotate } from "./handlers/user-annotate";
import { isPluginEdit } from "./helpers/plugin-utils";
import { Database } from "./types/database";
import { Context } from "./types/index";
import { isIssueCommentEvent, isIssueEvent } from "./types/typeguards";

/**
 * The main plugin function. Split for easier testing.
 */
export async function runPlugin(context: Context) {
  const { logger, eventName, env } = context;

  if (!context.adapters?.supabase && !context.adapters?.voyage) {
    const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY);
    const voyageClient = new VoyageAIClient({
      apiKey: env.VOYAGEAI_API_KEY,
    });
    context.adapters = await createAdapters(supabase, voyageClient, context);
    //Check the supabase adapter
    const isConnectionValid = await context.adapters.supabase.super.checkConnection();
    context.logger[isConnectionValid ? "ok" : "error"](`Supabase connection ${isConnectionValid ? "successful" : "failed"}`);
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
        await issueMatching(context as Context<"issues.opened">);
        break;
      case "issues.edited":
        if (isPluginEdit(context as Context<"issues.edited">)) {
          logger.info("Plugin edit detected, will run issue matching and checker.");
          await issueMatching(context as Context<"issues.edited">);
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
    return await issueMatching(context as Context<"issues.labeled">);
  } else {
    logger.error(`Unsupported event: ${eventName}`);
    return;
  }
  await updateCronState(context);
  logger.ok(`Exiting plugin`);
}
