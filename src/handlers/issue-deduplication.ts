import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { Context } from "../types";

export interface IssueGraphqlResponse {
  node: {
    title: string;
    number: number;
    url: string;
    body: string;
    repository: {
      name: string;
      owner: {
        login: string;
      };
    };
  };
  similarity: string;
  mostSimilarSentence: { sentence: string; similarity: number; index: number };
}

interface IssueResponse {
  node: {
    lastEditedAt: string | null; // This will be a string or null, depending on the API response
  };
}

/**
 * Sleep for the specified duration
 * @param ms duration in milliseconds
 */
function sleep(ms: number, context: Context): Promise<void> {
  context.logger.info("Sleeping for " + ms + " milliseconds");
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLastEditTime(context: Context, issueNodeId: string): Promise<string | null> {
  try {
    // Directly type the response using the IssueResponse interface
    const data: IssueResponse = await context.octokit.graphql(
      /* GraphQL */
      `
        query ($issueNodeId: ID!) {
          node(id: $issueNodeId) {
            ... on Issue {
              lastEditedAt
            }
          }
        }
      `,
      { issueNodeId }
    );

    // Check if the node exists
    if (!data.node) {
      context.logger.error("Issue does not exist", { issueNodeId });
      return null;
    }

    // Return lastEditedAt if available; otherwise return null
    return data.node.lastEditedAt || null;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    context.logger.error("Failed to fetch issue details", { stack: errorMessage });
    return null;
  }
}

/**
 * Checks if the current issue is a duplicate of an existing issue.
 * If a similar issue is found, a footnote is added to the current issue.
 * @param context The context object
 **/
export async function issueChecker(context: Context<"issues.opened" | "issues.edited">) {
  const {
    logger,
    adapters: { supabase },
    octokit,
    payload,
  } = context;

  const originalIssue = payload.issue;

  // Wait for the configured timeout period
  await sleep(context.config.editTimeout, context);

  const currentEventTime = context.eventName === "issues.opened" ? new Date(originalIssue.created_at).getTime() : new Date(originalIssue.updated_at).getTime();

  const lastEditedAt = await fetchLastEditTime(context, originalIssue.node_id);

  if (lastEditedAt === null) {
    logger.info("Last edited time is null, skipping deduplication check", {
      issueNumber: originalIssue.number,
    });
    return;
  }

  const latestEventTime = new Date(lastEditedAt).getTime();

  // Event should only proceed if it's the most recent action
  if (currentEventTime < latestEventTime) {
    logger.info("Event superseded by newer changes, skipping deduplication check", {
      issueNumber: originalIssue.number,
      currentEventType: context.eventName,
      currentEventTime: new Date(currentEventTime).toISOString(),
      latestUpdateTime: new Date(latestEventTime).toISOString(),
    });
    return;
  }

  // Use the latest issue data
  let issueBody = originalIssue.body;
  if (!issueBody) {
    logger.info("Issue body is empty", { originalIssue });
    return;
  }
  issueBody = removeFootnotes(issueBody);
  const similarIssues = await supabase.issue.findSimilarIssues({
    markdown: originalIssue.title + removeFootnotes(issueBody),
    currentId: originalIssue.node_id,
    threshold: context.config.dedupeWarningThreshold,
  });
  if (similarIssues && similarIssues.length > 0) {
    let processedIssues = await processSimilarIssues(similarIssues, context, issueBody);
    processedIssues = processedIssues.filter((issue) =>
      matchRepoOrgToSimilarIssueRepoOrg(payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
    );
    const matchIssues = processedIssues.filter((issue) => parseFloat(issue.similarity) / 100 >= context.config.dedupeMatchThreshold);
    if (matchIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.dedupeMatchThreshold} already exists`, { matchIssues });
      //To the issue body, add a footnote with the link to the similar issue
      const updatedBody = await handleMatchIssuesComment(context, payload, issueBody, processedIssues);
      issueBody = updatedBody || issueBody;
      await octokit.rest.issues.update({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: originalIssue.number,
        body: issueBody,
        state: "closed",
        state_reason: "not_planned",
      });
      return;
    }
    if (processedIssues.length > 0) {
      logger.info(`Similar issue which matches more than ${context.config.dedupeWarningThreshold} already exists`, { processedIssues });
      await handleSimilarIssuesComment(context, payload, issueBody, originalIssue.number, processedIssues);
      return;
    }
  } else {
    //Use the IssueBody (Without footnotes) to update the issue when no similar issues are found
    //Only if the issue has "possible duplicate" footnotes, update the issue
    if (checkIfDuplicateFootNoteExists(issueBody || "")) {
      await octokit.rest.issues.update({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: originalIssue.number,
        body: issueBody,
      });
    }
  }
  context.logger.info("No similar issues found");
}

function matchRepoOrgToSimilarIssueRepoOrg(repoOrg: string, similarIssueRepoOrg: string, repoName: string, similarIssueRepoName: string): boolean {
  return repoOrg === similarIssueRepoOrg && repoName === similarIssueRepoName;
}

function splitIntoSentences(text: string): string[] {
  const sentenceRegex = /([^.!?\s][^.!?]*(?:[.!?](?!['"]?\s|$)[^.!?]*)*[.!?]?['"]?(?=\s|$))/g;
  const sentences: string[] = [];
  let match;
  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push(match[0].trim());
  }
  return sentences;
}

/**
 * Finds the most similar sentence in a similar issue to a sentence in the current issue.
 * @param issueContent The content of the current issue
 * @param similarIssueContent The content of the similar issue
 * @returns The most similar sentence and its similarity score
 */
export function findMostSimilarSentence(
  issueContent: string,
  similarIssueContent: string,
  context: Context
): { sentence: string; similarity: number; index: number } {
  const issueSentences = splitIntoSentences(issueContent);
  const similarIssueSentences = splitIntoSentences(similarIssueContent);

  let maxSimilarity = 0;
  let mostSimilarSentence = "";
  let mostSimilarIndex = -1;

  issueSentences.forEach((sentence, index) => {
    const similarities = similarIssueSentences.map((similarSentence) => {
      const editDistance = findEditDistance(sentence, similarSentence);
      const maxLength = Math.max(sentence.length, similarSentence.length);
      // Normalized similarity (edit distance)
      return 1 - editDistance / maxLength;
    });
    const maxSentenceSimilarity = Math.max(...similarities);
    if (maxSentenceSimilarity > maxSimilarity) {
      maxSimilarity = maxSentenceSimilarity;
      mostSimilarSentence = sentence;
      mostSimilarIndex = index;
    }
  });

  if (!mostSimilarSentence) {
    context.logger.error("No similar sentence found");
  }
  return { sentence: mostSimilarSentence, similarity: maxSimilarity, index: mostSimilarIndex };
}

async function handleSimilarIssuesComment(
  context: Context,
  payload: Context<"issues.opened" | "issues.edited">["payload"],
  issueBody: string,
  issueNumber: number,
  issueList: IssueGraphqlResponse[]
) {
  const relevantIssues = issueList.filter((issue) =>
    matchRepoOrgToSimilarIssueRepoOrg(payload.repository.owner.login, issue.node.repository.owner.login, payload.repository.name, issue.node.repository.name)
  );

  if (relevantIssues.length === 0) {
    context.logger.info("No relevant issues found with the same repository and organization");
    return;
  }

  if (!issueBody) {
    return;
  }
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = issueBody.match(footnoteRegex) || [];
  const highestFootnoteIndex = existingFootnotes.length > 0 ? Math.max(...existingFootnotes.map((fn) => parseInt(fn.match(/\d+/)?.[0] ?? "0"))) : 0;
  let updatedBody = issueBody;
  const footnotes: string[] = [];
  // Sort relevant issues by similarity in ascending order
  relevantIssues.sort((a, b) => parseFloat(a.similarity) - parseFloat(b.similarity));
  relevantIssues.forEach((issue, index) => {
    const footnoteIndex = highestFootnoteIndex + index + 1; // Continue numbering from the highest existing footnote number
    const footnoteRef = `[^0${footnoteIndex}^]`;
    const modifiedUrl = issue.node.url.replace("https://github.com", "https://www.github.com");
    const { sentence } = issue.mostSimilarSentence;
    // Insert footnote reference in the body
    const sentencePattern = new RegExp(`${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    updatedBody = updatedBody.replace(sentencePattern, `${sentence} ${footnoteRef}`);

    // Add new footnote to the array
    footnotes.push(`${footnoteRef}: ⚠ ${issue.similarity}% possible duplicate - [${issue.node.title}](${modifiedUrl}#${issue.node.number})\n\n`);
  });
  // Append new footnotes to the body, keeping the previous ones
  if (footnotes.length > 0) {
    updatedBody += "\n\n" + footnotes.join("");
  }
  // Update the issue with the modified body
  await context.octokit.rest.issues.update({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issueNumber,
    body: updatedBody,
  });
}

//When similarity is greater than match threshold, Add Caution mentioning the issues to which its is very much similar
async function handleMatchIssuesComment(
  context: Context,
  payload: Context<"issues.opened" | "issues.edited">["payload"],
  issueBody: string,
  relevantIssues: IssueGraphqlResponse[]
): Promise<string | undefined> {
  if (!issueBody) {
    return;
  }
  // Find existing footnotes in the body
  const footnoteRegex = /\[\^(\d+)\^\]/g;
  const existingFootnotes = issueBody.match(footnoteRegex) || [];
  // Find the index with respect to the issue body string where the footnotes start if they exist
  const footnoteIndex = existingFootnotes[0] ? issueBody.indexOf(existingFootnotes[0]) : issueBody.length;
  let resultBuilder = "\n\n>[!CAUTION]\n> This issue may be a duplicate of the following issues:\n";
  // Sort relevant issues by similarity in descending order
  relevantIssues.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));
  // Append the similar issues to the resultBuilder
  relevantIssues.forEach((issue) => {
    const modifiedUrl = issue.node.url.replace("https://github.com", "https://www.github.com");
    resultBuilder += `> - [${issue.node.title}](${modifiedUrl}#${issue.node.number})\n`;
  });
  // Insert the resultBuilder into the issue body
  // Update the issue with the modified body
  return issueBody.slice(0, footnoteIndex) + resultBuilder + issueBody.slice(footnoteIndex);
}

// Process similar issues and return the list of similar issues with their similarity scores
export async function processSimilarIssues(similarIssues: IssueSimilaritySearchResult[], context: Context, issueBody: string): Promise<IssueGraphqlResponse[]> {
  const processedIssues = await Promise.all(
    similarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueUrl: IssueGraphqlResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeId: ID!) {
              node(id: $issueNodeId) {
                ... on Issue {
                  title
                  url
                  number
                  body
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                }
              }
            }
          `,
          { issueNodeId: issue.issue_id }
        );
        issueUrl.similarity = Math.round(issue.similarity * 100).toString();
        issueUrl.mostSimilarSentence = findMostSimilarSentence(issueBody, issueUrl.node.body, context);
        return issueUrl;
      } catch (error) {
        context.logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
        return null;
      }
    })
  );
  return processedIssues.filter((issue): issue is IssueGraphqlResponse => issue !== null);
}

/**
 * Finds the edit distance between two strings using dynamic programming.
 * The edit distance is a way of quantifying how dissimilar two strings are to one another by
 * counting the minimum number of operations required to transform one string into the other.
 * For more information, see: https://en.wikipedia.org/wiki/Edit_distance
 * @param sentenceA The first string
 * @param sentenceB The second string
 * @returns The edit distance between the two strings
 */
function findEditDistance(sentenceA: string, sentenceB: string): number {
  const lengthA = sentenceA.length;
  const lengthB = sentenceB.length;
  const distanceMatrix: number[][] = Array.from({ length: lengthA + 1 }, () => Array.from({ length: lengthB + 1 }, () => 0));

  for (let indexA = 0; indexA <= lengthA; indexA++) {
    for (let indexB = 0; indexB <= lengthB; indexB++) {
      if (indexA === 0) {
        distanceMatrix[indexA][indexB] = indexB;
      } else if (indexB === 0) {
        distanceMatrix[indexA][indexB] = indexA;
      } else if (sentenceA[indexA - 1] === sentenceB[indexB - 1]) {
        distanceMatrix[indexA][indexB] = distanceMatrix[indexA - 1][indexB - 1];
      } else {
        distanceMatrix[indexA][indexB] =
          1 + Math.min(distanceMatrix[indexA - 1][indexB], distanceMatrix[indexA][indexB - 1], distanceMatrix[indexA - 1][indexB - 1]);
      }
    }
  }

  return distanceMatrix[lengthA][lengthB];
}

/**
 * Removes all footnotes from the issue content.
 * This includes both the footnote references in the body and the footnote definitions at the bottom.
 * @param content The content of the issue
 * @returns The content without footnotes
 */
export function removeFootnotes(content: string): string {
  const footnoteDefRegex = /\[\^(\d+)\^\]: ⚠ \d+% possible duplicate - [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  let contentWithoutFootnotes = content.replace(footnoteDefRegex, "");
  if (footnotes) {
    footnotes.forEach((footnote) => {
      const footnoteNumber = footnote.match(/\d+/)?.[0];
      contentWithoutFootnotes = contentWithoutFootnotes.replace(new RegExp(`\\[\\^${footnoteNumber}\\^\\]`, "g"), "");
    });
  }
  contentWithoutFootnotes = removeCautionMessages(contentWithoutFootnotes);
  return contentWithoutFootnotes;
}

export function removeCautionMessages(content: string): string {
  const cautionRegex = />[!CAUTION]\n> This issue may be a duplicate of the following issues:\n((> - \[[^\]]+\]\([^)]+\)\n)+)/g;
  return content.replace(cautionRegex, "");
}

/**
 * Checks if a duplicate footnote exists in the content.
 * @param content The content to check for duplicate footnotes
 * @returns True if a duplicate footnote exists, false otherwise
 */
export function checkIfDuplicateFootNoteExists(content: string): boolean {
  const footnoteDefRegex = /\[\^(\d+)\^\]: ⚠ \d+% possible duplicate - [^\n]+(\n|$)/g;
  const footnotes = content.match(footnoteDefRegex);
  return !!footnotes;
}
