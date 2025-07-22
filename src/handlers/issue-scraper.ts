import { createClient } from "@supabase/supabase-js";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import markdownit from "markdown-it";
import plainTextPlugin from "markdown-it-plain-text";
import "dotenv/config";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "../adapters/index";
import { Context } from "../types/context";

interface MarkdownItWithPlainText extends markdownit {
  plainText: string;
}

function markdownToPlainText(markdown: string | null): string | null {
  if (!markdown) return markdown;
  const md = markdownit() as MarkdownItWithPlainText;
  md.use(plainTextPlugin);
  md.render(markdown);
  return md.plainText;
}

interface IssueMetadata {
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: string;
  repositoryName: string;
  repositoryId: number;
  assignees: string[];
  authorId: number;
  createdAt: string;
  closedAt: string | null;
  stateReason: string | null;
  updatedAt: string;
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: {
    login: string;
  } | null;
  assignees: {
    nodes: Array<{
      login: string;
    }>;
  };
  repository: {
    id: string;
    name: string;
    owner: {
      login: string;
    };
  };
}

interface GraphQlSearchResponse {
  search: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Array<IssueNode>;
  };
}

const SEARCH_ISSUES_QUERY = `
  query SearchIssues($searchText: String!, $after: String) {
    search(
      query: $searchText,
      type: ISSUE,
      first: 100,
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on Issue {
          id
          number
          title
          body
          state
          stateReason
          createdAt
          updatedAt
          closedAt
          author {
            login
          }
          assignees(first: 10) {
            nodes {
              login
            }
          }
          repository {
            id
            name
            owner {
              login
            }
          }
        }
      }
    }
  }
`;

async function fetchAuthorId(octokit: InstanceType<typeof Octokit>, login: string): Promise<number> {
  try {
    const response = await octokit.rest.users.getByUsername({ username: login });
    return response.data.id;
  } catch (error) {
    console.error(`Error fetching author ID for ${login}:`, error);
    return -1;
  }
}

async function fetchUserIssues(octokit: InstanceType<typeof Octokit>, username: string): Promise<IssueNode[]> {
  const allIssues: IssueNode[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const searchText = `assignee:${username} is:issue is:closed`;

  while (hasNextPage) {
    const variables: { searchText: string; after?: string } = {
      searchText,
    };
    if (cursor) {
      variables.after = cursor;
    }

    const response: GraphQlSearchResponse = await octokit.graphql<GraphQlSearchResponse>(SEARCH_ISSUES_QUERY, variables);

    const completedIssues = response.search.nodes.filter((issue) => issue.stateReason === "COMPLETED");
    allIssues.push(...completedIssues);

    hasNextPage = response.search.pageInfo.hasNextPage;
    cursor = response.search.pageInfo.endCursor;

    if (!cursor) break;
  }

  return allIssues;
}

// Pulls issues from GitHub and stores them in Supabase
export async function issueScraper(username: string, token?: string): Promise<string> {
  try {
    if (!username) {
      throw new Error("Username is required");
    }

    const required = ["GITHUB_TOKEN", "SUPABASE_URL", "SUPABASE_KEY", "VOYAGEAI_API_KEY"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    const context = {
      adapters: {},
      logger: {
        info: (message: string, data: Record<string, unknown>) => console.log("INFO:", message + ":", data),
        error: (message: string, data: Record<string, unknown>) => console.error("ERROR:", message + ":", data),
      },
      octokit: new Octokit({ auth: token || process.env.GITHUB_TOKEN }),
    } as unknown as Context;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    const voyageApiKey = process.env.VOYAGEAI_API_KEY;

    if (!supabaseUrl || !supabaseKey || !voyageApiKey) {
      throw new Error("Required environment variables are missing");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const voyageClient = new VoyageAIClient({ apiKey: voyageApiKey });
    const adapters = await createAdapters(supabase, voyageClient, context);

    const issues = await fetchUserIssues(context.octokit, username);
    const processedIssues: Array<{ issue: IssueMetadata; error?: string }> = [];

    for (const issue of issues) {
      try {
        const authorId = issue.author?.login ? await fetchAuthorId(context.octokit, issue.author.login) : -1;
        const repoOwner = issue.repository.owner.login;

        const metadata: IssueMetadata = {
          nodeId: issue.id,
          number: issue.number,
          title: issue.title || "",
          body: issue.body || "",
          state: issue.state,
          stateReason: issue.stateReason,
          repositoryName: issue.repository.name,
          repositoryId: parseInt(issue.repository.id),
          assignees: (issue.assignees?.nodes || []).map((assignee) => assignee.login),
          authorId,
          createdAt: issue.createdAt,
          closedAt: issue.closedAt,
          updatedAt: issue.updatedAt,
        };

        const markdown = metadata.body + " " + metadata.title;
        const plaintext = markdownToPlainText(markdown);
        const embedding = await adapters.voyage.embedding.createEmbedding(plaintext);

        const payload = {
          issue: metadata,
          action: "created",
          sender: {
            login: username,
          },
          repository: {
            id: parseInt(issue.repository.id),
            node_id: issue.repository.id,
            name: issue.repository.name,
            full_name: `${repoOwner}/${issue.repository.name}`,
            owner: {
              login: repoOwner,
              id: authorId,
              type: "User",
              site_admin: false,
            },
          },
        };

        const { error } = await supabase.from("issues").upsert({
          id: metadata.nodeId,
          markdown,
          plaintext,
          embedding: JSON.stringify(embedding),
          author_id: metadata.authorId,
          modified_at: metadata.updatedAt,
          payload: payload,
        });

        processedIssues.push({
          issue: metadata,
          error: error ? `Error storing issue: ${error.message}` : undefined,
        });
      } catch (error) {
        processedIssues.push({
          issue: {
            nodeId: issue.id,
            number: issue.number,
            title: issue.title || "",
            body: issue.body || "",
            state: issue.state,
            stateReason: issue.stateReason,
            repositoryName: issue.repository.name,
            repositoryId: parseInt(issue.repository.id),
            assignees: [],
            authorId: -1,
            createdAt: issue.createdAt,
            closedAt: issue.closedAt,
            updatedAt: issue.updatedAt,
          },
          error: `Error processing issue: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }

    return JSON.stringify(
      {
        success: true,
        stats: {
          storageSuccessful: processedIssues.filter((p) => !p.error).length,
          storageFailed: processedIssues.filter((p) => p.error).length,
        },
        errors: processedIssues
          .filter((p) => p.error)
          .map((p) => ({
            type: "storage",
            name: `${p.issue.repositoryName}#${p.issue.number}`,
            error: p.error,
          })),
        issues: processedIssues.map((p) => ({
          number: p.issue.number,
          title: p.issue.title,
          repo: p.issue.repositoryName,
          error: p.error,
        })),
      },
      null,
      2
    );
  } catch (error) {
    console.error("Error in issueScraper:", error);
    throw error;
  }
}
