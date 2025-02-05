import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "./adapters";
import { addComments } from "./handlers/add-comments";
import { addIssue } from "./handlers/add-issue";
import { deleteComment } from "./handlers/delete-comments";
import { deleteIssues } from "./handlers/delete-issue";
import { issueChecker } from "./handlers/issue-deduplication";
import { issueMatching } from "./handlers/issue-matching";
import { updateComment } from "./handlers/update-comments";
import { updateIssue } from "./handlers/update-issue";
import { Context } from "./types";
import { Database } from "./types/database";
import { isIssueCommentEvent, isIssueEvent } from "./types/typeguards";
import { issueTransfer } from "./handlers/transfer-issue";
import { completeIssue } from "./handlers/complete-issue";
import { commandHandler, userAnnotate } from "./handlers/user-annotate";

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
    context.adapters = createAdapters(supabase, voyageClient, context);
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
        return await issueChecker(context as Context<"issues.opened">);
      case "issues.edited":
        await updateIssue(context as Context<"issues.edited">);
        await issueMatching(context as Context<"issues.edited">);
        return await issueChecker(context as Context<"issues.edited">);
      case "issues.deleted":
        return await deleteIssues(context as Context<"issues.deleted">);
      case "issues.transferred":
        return await issueTransfer(context as Context<"issues.transferred">);
      case "issues.closed":
        return await completeIssue(context as Context<"issues.closed">);
    }
  } else if (eventName == "issues.labeled") {
    return await issueMatching(context as Context<"issues.labeled">);
  } else {
    logger.error(`Unsupported event: ${eventName}`);
  }
  logger.ok(`Exiting plugin`);
}
