import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { Context } from "../types/index";

const LOW_CONFIDENCE_RECOMMENDATION_THRESHOLD = 25;
const SAME_REPOSITORY_WEIGHT = 1;
const SAME_ORGANIZATION_WEIGHT = 0.75;
const GLOBAL_REPOSITORY_WEIGHT = 0.5;

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
  adjustedSimilarity: number;
}

type IssueNodeResponse = IssueGraphqlResponse | { node: null };

type IssueCommentSummary = {
  id: number;
  body?: string | null;
};

type SortedContributor = {
  login: string;
  matches: string[];
  maxSimilarity: number;
};

type CodeContributor = {
  login?: string | null;
  contributions?: number;
};

function hasIssueNode(response: IssueNodeResponse): response is IssueGraphqlResponse {
  return response.node !== null;
}

function getRepositoryWeight(context: Context<IssueMatchingEvents>, issue: IssueGraphqlResponse) {
  const currentOwner = context.payload.repository.owner.login;
  const currentRepo = context.payload.repository.name;
  const matchedOwner = issue.node.repository.owner.login;
  const matchedRepo = issue.node.repository.name;

  if (matchedOwner === currentOwner && matchedRepo === currentRepo) {
    return SAME_REPOSITORY_WEIGHT;
  }

  if (matchedOwner === currentOwner) {
    return SAME_ORGANIZATION_WEIGHT;
  }

  return GLOBAL_REPOSITORY_WEIGHT;
}

function getSortedContributors(matchResultArray: Map<string, string[]>): SortedContributor[] {
  return Array.from(matchResultArray.entries())
    .map(([login, matches]) => ({
      login,
      matches,
      maxSimilarity: matches.length ? Math.max(...matches.map((match) => parseInt(match.match(/`(\d+)% Match`/)?.[1] || "0"))) : 0,
    }))
    .sort((a, b) => b.maxSimilarity - a.maxSimilarity);
}

async function fetchRepositoryCodeContributors(context: Context<IssueMatchingEvents>, allowedLogins?: Set<string>): Promise<SortedContributor[]> {
  try {
    const { data: contributors } = await context.octokit.rest.repos.listContributors({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      per_page: 100,
    });

    return (contributors as CodeContributor[])
      .filter((contributor) => contributor.login && (!allowedLogins || allowedLogins.has(contributor.login)))
      .map((contributor) => {
        const contributions = contributor.contributions ?? 0;
        return {
          login: contributor.login as string,
          matches: [
            `> Repository contributor fallback for [${context.payload.repository.owner.login}/${context.payload.repository.name}](https://www.github.com/${context.payload.repository.owner.login}/${context.payload.repository.name}) (${contributions} commits)`,
          ],
          maxSimilarity: 0,
        };
      });
  } catch (error) {
    context.logger.error(`Failed to fetch repository contributors: ${error}`);
    return [];
  }
}

function addContributorMatch(matchResultArray: Map<string, string[]>, login: string, match: string) {
  if (matchResultArray.has(login)) {
    matchResultArray.get(login)?.push(match);
  } else {
    matchResultArray.set(login, [match]);
  }
}

function ensureContributors(matchResultArray: Map<string, string[]>, logins?: string[]) {
  if (!logins) {
    return;
  }
  for (const login of logins) {
    if (!matchResultArray.has(login)) {
      matchResultArray.set(login, []);
    }
  }
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
    const fetchPromises = similarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueObject: IssueNodeResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeId: ID!) {
              node(id: $issueNodeId) {
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
          { issueNodeId: issue.issue_id }
        );
        if (!hasIssueNode(issueObject)) {
          context.logger.warn("Skipping non-issue node in recommendations.", { issueNodeId: issue.issue_id });
          return null;
        }
        issueObject.similarity = issue.similarity;
        issueObject.adjustedSimilarity = issue.similarity * getRepositoryWeight(context, issueObject);
        return issueObject;
      } catch (error) {
        context.logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
        return null;
      }
    });
    const issueList = await Promise.allSettled(fetchPromises);

    logger.debug("Fetched similar issues", { issueList });
    issueList.forEach((issuePromise: PromiseSettledResult<IssueGraphqlResponse | null>) => {
      if (!issuePromise || issuePromise.status === "rejected" || !issuePromise.value) {
        return;
      }
      const issue = issuePromise.value as IssueGraphqlResponse;
      const hasAssignees = issue.node.assignees.nodes.length > 0;
      const isCompletedWithAssignees = issue.node.closed && issue.node.stateReason === "COMPLETED" && hasAssignees;
      const isEligible = options.includeNonCompleted ? hasAssignees : isCompletedWithAssignees;

      if (isEligible) {
        const assignees = issue.node.assignees.nodes;
        assignees.forEach((assignee: { login: string; url: string }) => {
          if (options.allowedLogins && !options.allowedLogins.has(assignee.login)) {
            return;
          }
          const similarityPercentage = Math.round(issue.adjustedSimilarity * 100);
          const issueLink = issue.node.url.replace(/https?:\/\/github.com/, "https://www.github.com");
          addContributorMatch(
            matchResultArray,
            assignee.login,
            `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`
          );
        });
      }
    });

    ensureContributors(matchResultArray, options.ensureLogins);

    let sortedContributors = getSortedContributors(matchResultArray);
    const hasConfidentIssueMatch = sortedContributors.some((contributor) => contributor.maxSimilarity >= LOW_CONFIDENCE_RECOMMENDATION_THRESHOLD);
    if (!hasConfidentIssueMatch) {
      const codeContributors = await fetchRepositoryCodeContributors(context, options.allowedLogins);
      matchResultArray.clear();
      for (const contributor of codeContributors) {
        matchResultArray.set(contributor.login, contributor.matches);
      }
      ensureContributors(matchResultArray, options.ensureLogins);
      sortedContributors = getSortedContributors(matchResultArray);
    }

    logger.debug("Matched issues", { matchResultArray, length: matchResultArray.size });

    logger.debug("Sorted contributors", { sortedContributors });
    return { matchResultArray, similarIssues, sortedContributors };
  }

  if (options.ensureLogins && options.ensureLogins.length > 0) {
    ensureContributors(matchResultArray, options.ensureLogins);
    const sortedContributors = getSortedContributors(matchResultArray);
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
