import { Context } from "../types/index";
import { removeFootnotes } from "./issue-deduplication";

export async function completeIssue(context: Context<"issues.closed">) {
  const {
    logger,
    adapters: { supabase, kv },
    payload,
  } = context;

  // Only handle issues closed as completed
  if (payload.issue.state_reason !== "completed") {
    logger.debug("Issue not marked as completed, skipping");
    return;
  }

  // Skip issues without assignees
  if (!payload.issue.assignees || payload.issue.assignees.length === 0) {
    logger.debug("Issue has no assignees, skipping");
    return;
  }

  const id = payload.issue.node_id;
  const isPrivate = payload.repository.private;
  const markdown = payload.issue.body && payload.issue.title ? payload.issue.body + " " + payload.issue.title : null;
  const authorId = payload.issue.user?.id || -1;

  try {
    if (!markdown) {
      logger.error("Issue body is empty");
      return;
    }

    // Clean issue by removing footnotes
    const cleanedIssue = removeFootnotes(markdown);

    // Add completed status to payload
    const updatedPayload = {
      ...payload,
      issue: {
        ...payload.issue,
        completed: true,
        completed_at: new Date().toISOString(),
        has_assignees: true, // Flag to indicate this is a valid completed issue with assignees
      },
    };

    // Check if issue exists
    const existingIssue = await supabase.issue.getIssue(id);

    if (existingIssue && existingIssue.length > 0) {
      // Update existing issue
      await supabase.issue.updateIssue({
        markdown: cleanedIssue,
        id,
        payload: updatedPayload,
        isPrivate,
        author_id: authorId,
      });
      await kv.removeIssue(payload.issue.html_url);
      logger.ok(`Successfully updated completed issue! ${payload.issue.id}`, payload.issue);
    } else {
      // Create new issue if it doesn't exist
      await supabase.issue.createIssue({
        id,
        payload: updatedPayload,
        isPrivate,
        markdown: cleanedIssue,
        author_id: authorId,
      });
      logger.ok(`Successfully created completed issue! ${payload.issue.id}`, payload.issue);
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error handling completed issue:`, { error: error, stack: error.stack, issue: payload.issue });
      throw error;
    } else {
      logger.error(`Error handling completed issue:`, { err: error, issue: payload.issue });
      throw error;
    }
  }
  logger.debug(`Exiting completeIssue`);
}
