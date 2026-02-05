import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { Context } from "../types/index";

export interface IssueGraphqlResponse {
  node: {
    title: string;
    url: string;
    state: string;
    stateReason: string;
    closed: boolean;
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
    assignees: {
      nodes: Array<{
        login: string;
        url: string;
      }>;
    };
  };
  similarity: number;
}

type IssueCommentSummary = {
  id: number;
  body?: string | null;
};

type IssueNode = IssueGraphqlResponse["node"];
type GraphqlNode = (IssueNode & { __typename?: string }) | { __typename?: string } | null;

const ISSUE_NODE_BATCH_SIZE = 25;

function isIssueNode(node: GraphqlNode): node is IssueNode & { __typename?: string } {
  return Boolean(node && typeof node === "object" && (node as { __typename?: string }).__typename === "Issue");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeError(error: unknown): Error | { stack: string } {
  return error instanceof Error ? error : { stack: String(error) };
}

export async function issueMatchingWithComment(context: Context<"issues.opened" | "issues.edited" | "issues.labeled">) {
  const { logger, octokit, payload } = context;
  const issue = payload.issue;
  const commentStart = ">The following contributors may be suitable for this task:";

  const result = await issueMatching(context);

  if (!result) {
    return;
  }

  const { matchResultArray, sortedContributors } = result;

  // Fetch if any previous comment exists
  const listIssues = (await octokit.paginate(octokit.rest.issues.listComments, {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issue.number,
  })) as IssueCommentSummary[];

  //Check if the comment already exists
  const existingComment = listIssues.find((comment) => comment.body && comment.body.includes(">[!NOTE]" + "\n" + commentStart));

  if (matchResultArray.size === 0) {
    if (existingComment) {
      // If the comment already exists, delete it
      await octokit.rest.issues.deleteComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        comment_id: existingComment.id,
      });
    }
    logger.debug("No suitable contributors found");
    return;
  }

  // Use alwaysRecommend if specified
  const numToShow = context.config.alwaysRecommend || 3;
  const limitedContributors = new Map(sortedContributors.slice(0, numToShow).map(({ login, matches }) => [login, matches]));

  const comment = commentBuilder(limitedContributors);

  logger.debug("Comment to be added", { comment });

  if (existingComment) {
    await context.octokit.rest.issues.updateComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      comment_id: existingComment.id,
      body: comment,
    });
  } else {
    await context.octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: comment,
    });
  }
}

type IssueMatchingEvents = "issues.opened" | "issues.edited" | "issues.labeled" | "issue_comment.created";

/**
 * Checks if the current issue is a duplicate of an existing issue.
 * If a similar completed issue is found, it will add a comment to the issue with the assignee(s) of the similar issue.
 * @param context The context object
 **/
export async function issueMatching(context: Context<IssueMatchingEvents>) {
  return issueMatchingInternal(context, {});
}

export async function issueMatchingForUsers(context: Context<IssueMatchingEvents>, users: string[]) {
  const uniqueUsers = Array.from(new Set(users.map((u) => u.trim()).filter(Boolean)));
  return issueMatchingInternal(context, {
    allowedLogins: new Set(uniqueUsers),
    ensureLogins: uniqueUsers,
    forceThresholdZero: true,
    topK: 50,
    includeNonCompleted: true,
  });
}

type IssueMatchingInternalOptions = {
  allowedLogins?: Set<string>;
  ensureLogins?: string[];
  forceThresholdZero?: boolean;
  topK?: number;
  includeNonCompleted?: boolean;
};

async function issueMatchingInternal(context: Context<IssueMatchingEvents>, options: IssueMatchingInternalOptions) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const issue = payload.issue;
  const authorType = issue.user?.type;
  const isHumanAuthor = authorType === "User";
  if (!isHumanAuthor) {
    logger.debug("Skipping issue matching for non-human author.", {
      author: issue.user?.login,
      type: authorType,
      issue: issue.number,
    });
    return null;
  }
  const issueContent = issue.body + issue.title;
  const matchResultArray: Map<string, Array<string>> = new Map();

  // If alwaysRecommend is enabled, use a lower threshold to ensure we get enough recommendations
  const threshold =
    options.forceThresholdZero || (context.config.alwaysRecommend && context.config.alwaysRecommend > 0) ? 0 : context.config.jobMatchingThreshold;

  const similarIssues = await supabase.issue.findSimilarIssuesToMatch({
    markdown: issueContent,
    threshold: threshold,
    currentId: issue.node_id,
    topK: options.topK,
  });

  if (similarIssues && similarIssues.length > 0) {
    similarIssues.sort((a: IssueSimilaritySearchResult, b: IssueSimilaritySearchResult) => b.similarity - a.similarity); // Sort by similarity
    const similarityById = new Map(similarIssues.map((entry) => [entry.issue_id, entry.similarity]));
    const issueIdBatches = chunkArray(
      similarIssues.map((entry) => entry.issue_id),
      ISSUE_NODE_BATCH_SIZE
    );
    const issueList: IssueGraphqlResponse[] = [];

    for (const batch of issueIdBatches) {
      try {
        const response: { nodes: GraphqlNode[] } = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeIds: [ID!]!) {
              nodes(ids: $issueNodeIds) {
                __typename
                ... on Issue {
                  title
                  url
                  state
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                  stateReason
                  closed
                  assignees(first: 10) {
                    nodes {
                      login
                      url
                    }
                  }
                }
              }
            }
          `,
          { issueNodeIds: batch }
        );

        response.nodes.forEach((node, index) => {
          const issueId = batch[index];
          if (!issueId) {
            return;
          }
          if (!isIssueNode(node)) {
            context.logger.debug("Skipping non-issue node in recommendations.", { issueNodeId: issueId });
            return;
          }
          const similarity = similarityById.get(issueId);
          if (similarity === undefined) {
            context.logger.debug("Skipping issue node missing similarity mapping.", { issueNodeId: issueId });
            return;
          }
          issueList.push({ node, similarity });
        });
      } catch (error) {
        context.logger.error("Failed to fetch issue batch for recommendations.", {
          batchSize: batch.length,
          error: normalizeError(error),
        });
      }
    }

    logger.debug("Fetched similar issues", { issueList });
    issueList.forEach((issue: IssueGraphqlResponse) => {
      const hasAssignees = issue.node.assignees.nodes.length > 0;
      const isCompletedWithAssignees = issue.node.closed && issue.node.stateReason === "COMPLETED" && hasAssignees;
      const isEligible = options.includeNonCompleted ? hasAssignees : isCompletedWithAssignees;

      if (isEligible) {
        const assignees = issue.node.assignees.nodes;
        assignees.forEach((assignee: { login: string; url: string }) => {
          if (options.allowedLogins && !options.allowedLogins.has(assignee.login)) {
            return;
          }
          const similarityPercentage = Math.round(issue.similarity * 100);
          const issueLink = issue.node.url.replace(/https?:\/\/github.com/, "https://www.github.com");
          if (matchResultArray.has(assignee.login)) {
            matchResultArray
              .get(assignee.login)
              ?.push(
                `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`
              );
          } else {
            matchResultArray.set(assignee.login, [
              `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`,
            ]);
          }
        });
      }
    });

    if (options.ensureLogins) {
      for (const login of options.ensureLogins) {
        if (!matchResultArray.has(login)) {
          matchResultArray.set(login, []);
        }
      }
    }

    logger.debug("Matched issues", { matchResultArray, length: matchResultArray.size });

    // Convert Map to array and sort by highest similarity
    const sortedContributors = Array.from(matchResultArray.entries())
      .map(([login, matches]) => ({
        login,
        matches,
        maxSimilarity: matches.length ? Math.max(...matches.map((match) => parseInt(match.match(/`(\d+)% Match`/)?.[1] || "0"))) : 0,
      }))
      .sort((a, b) => b.maxSimilarity - a.maxSimilarity);

    logger.debug("Sorted contributors", { sortedContributors });
    return { matchResultArray, similarIssues, sortedContributors };
  }

  if (options.ensureLogins && options.ensureLogins.length > 0) {
    for (const login of options.ensureLogins) {
      if (!matchResultArray.has(login)) {
        matchResultArray.set(login, []);
      }
    }
    const sortedContributors = Array.from(matchResultArray.entries())
      .map(([login, matches]) => ({
        login,
        matches,
        maxSimilarity: 0,
      }))
      .sort((a, b) => b.maxSimilarity - a.maxSimilarity);
    return { matchResultArray, similarIssues: [], sortedContributors };
  }

  logger.info(`Exiting issueMatching handler!`, { similarIssues: similarIssues || "No similar issues found" });

  return null;
}

/**
 * Builds the comment to be added to the issue
 * @param matchResultArray The array of issues to be matched
 * @returns The comment to be added to the issue
 */
function commentBuilder(matchResultArray: Map<string, Array<string>>): string {
  const commentLines: string[] = [">[!NOTE]", ">The following contributors may be suitable for this task:"];
  matchResultArray.forEach((issues: Array<string>, assignee: string) => {
    commentLines.push(`>### [${assignee}](https://www.github.com/${assignee})`);
    issues.forEach((issue: string) => {
      commentLines.push(issue);
    });
  });
  return commentLines.join("\n");
}
