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

type IssueNodeResponse = IssueGraphqlResponse | { node: null };

type IssueCommentSummary = {
  id: number;
  body?: string | null;
};

type RepositoryInfo = {
  owner: string;
  repo: string;
};

type SortedContributor = {
  login: string;
  matches: string[];
  maxSimilarity: number;
};

type RepositoryContributor = {
  login?: string | null;
  type?: string | null;
  html_url?: string | null;
  contributions?: number;
};

const MINIMUM_CONFIDENT_MATCH_PERCENTAGE = 25;

function hasIssueNode(response: IssueNodeResponse): response is IssueGraphqlResponse {
  return response.node !== null;
}

function getCurrentRepository(context: Context<IssueMatchingEvents>): RepositoryInfo | null {
  if (context.payload.repository) {
    return {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    };
  }

  const repositoryUrl = (context.payload.issue as { repository_url?: string }).repository_url;
  const match = repositoryUrl?.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

function getContextWeight(currentRepository: RepositoryInfo | null, issue: IssueGraphqlResponse) {
  if (!currentRepository) {
    return 0.5;
  }
  const matchedOwner = issue.node.repository.owner.login;
  const matchedRepo = issue.node.repository.name;
  if (matchedOwner === currentRepository.owner && matchedRepo === currentRepository.repo) {
    return 1;
  }
  if (matchedOwner === currentRepository.owner) {
    return 0.75;
  }
  return 0.5;
}

function sortContributors(matchResultArray: Map<string, Array<string>>, commitCounts: Map<string, number> = new Map()): SortedContributor[] {
  return Array.from(matchResultArray.entries())
    .map(([login, matches]) => ({
      login,
      matches,
      maxSimilarity: matches.length ? Math.max(...matches.map((match) => parseInt(match.match(/`(\d+)% Match`/)?.[1] || "0"))) : 0,
    }))
    .sort((a, b) => b.maxSimilarity - a.maxSimilarity || (commitCounts.get(b.login) || 0) - (commitCounts.get(a.login) || 0) || a.login.localeCompare(b.login));
}

function needsContributorFallback(sortedContributors: SortedContributor[]) {
  return sortedContributors.length === 0 || sortedContributors[0].maxSimilarity <= MINIMUM_CONFIDENT_MATCH_PERCENTAGE;
}

function isUsableContributor(contributor: RepositoryContributor, issueAuthor?: string) {
  const login = contributor.login;
  if (!login || login === issueAuthor) {
    return false;
  }
  return contributor.type !== "Bot" && !login.endsWith("[bot]");
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
  const currentRepository = getCurrentRepository(context);
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
          const similarityPercentage = Math.round(issue.similarity * getContextWeight(currentRepository, issue) * 100);
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

    let sortedContributors = sortContributors(matchResultArray);
    if (!options.ensureLogins && needsContributorFallback(sortedContributors)) {
      const fallback = await getRepositoryContributorFallback(context, currentRepository);
      if (fallback) {
        sortedContributors = fallback.sortedContributors;
        logger.debug("Using repository contributor fallback", { sortedContributors });
        return { matchResultArray: fallback.matchResultArray, similarIssues, sortedContributors };
      }
    }

    logger.debug("Sorted contributors", { sortedContributors });
    return { matchResultArray, similarIssues, sortedContributors };
  }

  if (options.ensureLogins && options.ensureLogins.length > 0) {
    for (const login of options.ensureLogins) {
      if (!matchResultArray.has(login)) {
        matchResultArray.set(login, []);
      }
    }
    const sortedContributors = sortContributors(matchResultArray);
    return { matchResultArray, similarIssues: [], sortedContributors };
  }

  const fallback = await getRepositoryContributorFallback(context, currentRepository);
  if (fallback) {
    logger.debug("Using repository contributor fallback after empty similarity search", { sortedContributors: fallback.sortedContributors });
    return { matchResultArray: fallback.matchResultArray, similarIssues: similarIssues || [], sortedContributors: fallback.sortedContributors };
  }

  logger.info(`Exiting issueMatching handler!`, { similarIssues: similarIssues || "No similar issues found" });

  return null;
}

async function getRepositoryContributorFallback(context: Context<IssueMatchingEvents>, currentRepository: RepositoryInfo | null) {
  if (!currentRepository) {
    context.logger.debug("Skipping repository contributor fallback because repository context is unavailable.");
    return null;
  }

  let contributors: RepositoryContributor[];
  try {
    const response = await context.octokit.rest.repos.listContributors({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      per_page: 100,
    });
    contributors = response.data as RepositoryContributor[];
  } catch (error) {
    context.logger.error(`Failed to fetch repository contributors: ${error}`);
    return null;
  }

  const commitCounts = new Map<string, number>();
  const matchResultArray: Map<string, Array<string>> = new Map();

  for (const contributor of contributors) {
    if (!isUsableContributor(contributor, context.payload.issue.user?.login)) {
      continue;
    }
    const login = contributor.login as string;
    const contributions = contributor.contributions || 0;
    commitCounts.set(login, contributions);
    matchResultArray.set(login, [`> \`Repository contributor fallback\` ${contributions} commits in this repository`]);
  }

  if (matchResultArray.size === 0) {
    return null;
  }

  return {
    matchResultArray,
    sortedContributors: sortContributors(matchResultArray, commitCounts),
  };
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
