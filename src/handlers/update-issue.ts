import { Context } from "../types/index";
import { removeFootnotes } from "./issue-deduplication";

export async function updateIssue(context: Context<"issues.edited">) {
  const {
    logger,
    adapters: { supabase, kv },
    payload,
    config,
  } = context;
  const id = payload.issue.node_id;
  const isPrivate = payload.repository.private;
  const markdown = payload.issue.body && payload.issue.title ? payload.issue.body + " " + payload.issue.title : null;
  const authorId = payload.issue.user?.id || -1;
  // Fetch the previous issue and update it in the db
  try {
    if (!markdown) {
      logger.error("Issue body is empty");
      return;
    }
    //clean issue by removing footnotes
    const cleanedIssue = removeFootnotes(markdown);

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping issue update in database", { issue: payload.issue.number, issue_url: payload.issue.html_url });
      return;
    }

    await supabase.issue.updateIssue({ markdown: cleanedIssue, id, payload, isPrivate, author_id: authorId });
    await kv.addIssue(payload.issue.html_url);
    logger.ok(`Successfully updated issue! ${payload.issue.id}`, payload.issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error updating issue:`, { error: error, stack: error.stack, issue: payload.issue });
      throw error;
    } else {
      logger.error(`Error updating issue:`, { err: error, issue: payload.issue });
      throw error;
    }
  }
  logger.debug(`Exiting updateIssue`);
}
