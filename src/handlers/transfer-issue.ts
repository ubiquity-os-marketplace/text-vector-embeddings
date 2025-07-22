import { Context } from "../types/index";

export async function issueTransfer(context: Context<"issues.transferred">) {
  const {
    logger,
    adapters: { supabase, kv },
  } = context;
  const { changes, issue } = context.payload;
  const nodeId = issue.node_id;
  const { new_issue, new_repository } = changes;
  //Fetch the new details of the issue
  const newIssueNodeId = new_issue.node_id;
  const markdown = new_issue.body && new_issue.title ? new_issue.body + " " + new_issue.title : null;
  const authorId = new_issue.user?.id || -1;
  const isPrivate = new_repository.private;

  //Delete the issue from the old repository
  //Create the new issue in the new repository
  try {
    await supabase.issue.deleteIssue(nodeId);
    await supabase.issue.createIssue({ id: newIssueNodeId, payload: new_issue, isPrivate, markdown, author_id: authorId });
    await kv.updateIssue(issue.html_url, new_issue.html_url);
    logger.ok(`Successfully transferred issue!`, new_issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error transferring issue:`, { error: error, stack: error.stack, issue: new_issue });
      throw error;
    } else {
      logger.error(`Error transferring issue:`, { err: error, error: new Error(), issue: new_issue });
      throw error;
    }
  }
  logger.debug(`Exiting issueTransfer`);
}
