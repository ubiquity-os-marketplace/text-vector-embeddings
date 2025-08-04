import { Context } from "../types/index";
import { removeFootnotes } from "./issue-deduplication";

export async function addIssue(context: Context<"issues.opened">) {
  const {
    logger,
    adapters: { supabase, kv },
    payload,
    config,
  } = context;
  const issue = payload.issue;
  const markdown = payload.issue.body && payload.issue.title ? `${payload.issue.body} ${payload.issue.title}` : null;
  const authorId = issue.user?.id || -1;
  const id = issue.node_id;
  const isPrivate = payload.repository.private;

  try {
    if (!markdown) {
      logger.error("Issue body is empty", { issue });
      return;
    }
    const cleanedIssue = removeFootnotes(markdown);

    if (config.demoFlag) {
      logger.info("Demo mode active - skipping issue storage", { issue: issue.number, issue_url: issue.html_url });
      return;
    }

    await supabase.issue.createIssue({ id, payload, isPrivate, markdown: cleanedIssue, author_id: authorId });
    await kv.addIssue(issue.html_url);
    logger.ok(`Successfully created issue!`, issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error creating issue:`, { error: error, issue: issue });
      throw error;
    } else {
      logger.error(`Error creating issue:`, { err: error, issue: issue });
      throw error;
    }
  }
  logger.debug(`Exiting addIssue`);
}
