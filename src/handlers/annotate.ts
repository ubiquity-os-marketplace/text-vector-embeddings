import { Context } from "../types";
import { Comment } from "../types/comment";
import { processSimilarIssues, IssueGraphqlResponse } from "./issue-deduplication";

export async function annotate(context: Context, commentId: string | null, scope: string) {
  const { logger, octokit, payload } = context;

  const repository = payload.repository;

  if (!commentId) {
    const response = await octokit.rest.issues.listComments({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      per_page: 100,
    });
    const commments = response.data;
    if (commments.length > 1) {
      const commentBeforeAnnotate = commments[commments.length - 2];
      await commentChecker(context, commentBeforeAnnotate, scope);
    } else {
      logger.error("No comments before the annotate command");
    }
  } else {
    const { data } = await octokit.rest.issues.getComment({
      owner: repository.owner.login,
      repo: repository.name,
      comment_id: parseInt(commentId, 10),
    });
    await commentChecker(context, data, scope);
  }
}

/**
 * Checks if the comment is similar to a existing issue.
 * If a similar issue is found, a footnote is added to the comment.
 * @param context The context object
 * @param comment The comment object
 * @param scope The scope of the annotation
 **/
export async function commentChecker(context: Context, comment: Comment, scope: string) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  let commentBody = comment.body;
  if (!commentBody) {
    logger.info("Comment body is empty", { commentBody });
    return;
  }
  commentBody = removeAnnotateFootnotes(commentBody);
  const similarIssues = await supabase.issue.findSimilarIssues({
    markdown: commentBody,
    currentId: comment.node_id,
    threshold: context.config.warningThreshold,
  });
  if (similarIssues && similarIssues.length > 0) {
    let processedIssues = await processSimilarIssues(similarIssues, context, commentBody);
    processedIssues = processedIssues.filter((issue) =>
      filterByScope(scope, payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
    );
    if (processedIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.warningThreshold} already exists`, { processedIssues });
      await handleSimilarIssuesComment(context, payload, commentBody, comment.id, processedIssues);
      return;
    }
  }
  context.logger.info("No similar issues found for comment", { commentBody });
}

function filterByScope(scope: string, repoOrg: string, similarIssueRepoOrg: string, repoName: string, similarIssueRepoName: string): boolean {
  switch (scope) {
    case "global":
      return true;
    case "org":
      return repoOrg === similarIssueRepoOrg;
    case "repo":
      return repoOrg === similarIssueRepoOrg && repoName === similarIssueRepoName;
    default:
      return false;
  }
}

async function handleSimilarIssuesComment(
  context: Context,
  payload: Context["payload"],
  commentBody: string,
  commentId: number,
  issueList: IssueGraphqlResponse[]
) {
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = commentBody.match(footnoteRegex) || [];
  const highestFootnoteIndex = existingFootnotes.length > 0 ? Math.max(...existingFootnotes.map((fn) => parseInt(fn.match(/\d+/)?.[0] ?? "0"))) : 0;
  let updatedBody = commentBody;
  let footnotes: string[] | undefined;
  // Sort relevant issues by similarity in ascending order
  issueList.sort((a, b) => parseFloat(a.similarity) - parseFloat(b.similarity));
  issueList.forEach((issue, index) => {
    const footnoteIndex = highestFootnoteIndex + index + 1; // Continue numbering from the highest existing footnote number
    const footnoteRef = `[^0${footnoteIndex}^]`;
    const modifiedUrl = issue.node.url.replace("https://github.com", "https://www.github.com");
    const { sentence } = issue.mostSimilarSentence;
    // Insert footnote reference in the body
    const sentencePattern = new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    updatedBody = updatedBody.replace(sentencePattern, `${sentence} ${footnoteRef}`);

    // Initialize footnotes array if not already done
    if (!footnotes) {
      footnotes = [];
    }
    // Add new footnote to the array
    footnotes.push(`${footnoteRef}: ${issue.similarity}% similar to issue: [${issue.node.title}](${modifiedUrl}#${issue.node.number})\n\n`);
  });
  // Append new footnotes to the body, keeping the previous ones
  if (footnotes) {
    updatedBody += "\n\n" + footnotes.join("");
  }
  // Update the comment with the modified body
  await context.octokit.rest.issues.updateComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    comment_id: commentId,
    body: updatedBody,
  });
}

/**
 * Checks if a annotate footnote exists in the content.
 * @param content The content to check for annotate footnotes
 * @returns True if a annotate footnote exists, false otherwise
 */
export function checkIfAnnotateFootNoteExists(content: string): boolean {
  const footnoteDefRegex = /\[\^(\d+)\^\]: \d+% similar to issue: [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  return !!footnotes;
}

/**
 * Removes annotate footnotes from the comment content.
 * This includes both the footnote references in the body and the footnote definitions at the bottom.
 * @param content The content of the comment
 * @returns The content without footnotes
 */
export function removeAnnotateFootnotes(content: string): string {
  const footnoteDefRegex = /\[\^(\d+)\^\]: \d+% similar to issue: [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  let contentWithoutFootnotes = content.replace(footnoteDefRegex, "");
  if (footnotes) {
    footnotes.forEach((footnote) => {
      const footnoteNumber = footnote.match(/\d+/)?.[0];
      contentWithoutFootnotes = contentWithoutFootnotes.replace(new RegExp(`\\[\\^${footnoteNumber}\\^\\]`, "g"), "");
    });
  }
  return contentWithoutFootnotes;
}
