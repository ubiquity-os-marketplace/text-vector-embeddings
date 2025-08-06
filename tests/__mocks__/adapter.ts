import { Context } from "../../src/types/index";
import { Comment, CommentData } from "../../src/adapters/supabase/helpers/comment";
import { STRINGS } from "./strings";
import { jest } from "@jest/globals";
import { markdownToPlainText } from "../../src/adapters/utils/markdown-to-plaintext";
import { IssueData } from "../../src/adapters/supabase/helpers/issues";

export interface CommentMock {
  id: string;
  plaintext: string | null;
  author_id: number;
  payload?: Record<string, unknown> | null;
  type?: string;
  issue_id?: string;
  embedding: number[];
}

export interface IssueMock {
  id: string;
  markdown: string | null;
  author_id: number;
  payload?: Record<string, unknown> | null;
  isPrivate?: boolean;
  embedding: number[];
}

export function createMockAdapters(context: Context) {
  const commentMap: Map<string, CommentMock> = new Map();
  const issueMap: Map<string, IssueData> = new Map();

  return {
    supabase: {
      comment: {
        createComment: jest.fn(async (commentData: CommentData) => {
          if (commentMap.has(commentData.id)) {
            throw new Error("Comment already exists");
          }
          let plaintext = commentData.markdown ? markdownToPlainText(commentData.markdown) : null;
          if (commentData.isPrivate) {
            plaintext = null;
          }
          const embedding = await context.adapters.voyage.embedding.createEmbedding(plaintext);
          commentMap.set(commentData.id, {
            id: commentData.id,
            plaintext,
            author_id: commentData.author_id,
            embedding,
            issue_id: commentData.issue_id,
          });
          console.log("Comment created", commentData.id, commentMap.get(commentData.id));
        }),
        updateComment: jest.fn(async (commentData: CommentData) => {
          if (!commentMap.has(commentData.id)) {
            console.log("Current comment map", commentMap);
            throw new Error(STRINGS.COMMENT_DOES_NOT_EXIST);
          }
          let plaintext = commentData.markdown ? markdownToPlainText(commentData.markdown) : null;
          if (commentData.isPrivate) {
            plaintext = null;
          }
          const embedding = await context.adapters.voyage.embedding.createEmbedding(plaintext);
          commentMap.set(commentData.id, {
            id: commentData.id,
            plaintext,
            author_id: commentData.author_id,
            embedding,
            payload: commentData.payload,
            issue_id: commentData.issue_id,
          });
        }),
        deleteComment: jest.fn(async (commentNodeId: string) => {
          if (!commentMap.has(commentNodeId)) {
            throw new Error(STRINGS.COMMENT_DOES_NOT_EXIST);
          }
          commentMap.delete(commentNodeId);
        }),
        getComment: jest.fn(async (commentNodeId: string) => {
          if (!commentMap.has(commentNodeId)) {
            throw new Error(STRINGS.COMMENT_DOES_NOT_EXIST);
          }
          return commentMap.get(commentNodeId);
        }),
      } as unknown as Comment,

      issue: {
        getIssue: jest.fn(async (issueId: string) => {
          if (!issueMap.has(issueId)) return null;
          return issueMap.get(issueId);
        }),
        findSimilarIssues: jest.fn(async (issueContent: string, threshold: number, currentIssueId: string) => {
          // Return empty array for first issue in each test
          if (currentIssueId === "warning1" || currentIssueId === "match1") {
            return [];
          }

          // For warning threshold test (similarity around 0.8)
          if (currentIssueId === "warning2") {
            return [
              {
                issue_id: "warning1",
                similarity: 0.8,
              },
            ];
          }

          // For match threshold test (similarity above 0.95)
          if (currentIssueId === "match2") {
            return [
              {
                issue_id: "match1",
                similarity: 0.96,
              },
            ];
          }

          return [];
        }),
        findSimilarIssuesToMatch: jest.fn(async (params: { markdown: string; threshold: number; currentId: string }) => {
          if (params.currentId === "task_complete") {
            return [{ id: "similar3", similarity: 0.98 }];
          } else if (params.currentId === "task_complete_always") {
            return [{ id: "similar5", similarity: 0.5 }];
          }
          return [];
        }),
        createIssue: jest.fn(async (issue: IssueData) => {
          issueMap.set(issue.id, issue);
        }),
        updateIssue: jest.fn(async (issue: IssueData) => {
          issueMap.set(issue.id, issue);
        }),
      },
      fetchComments: jest.fn(async (issueId: string) => {
        return Array.from(commentMap.values()).filter((comment) => comment.issue_id === issueId);
      }),
    },
    voyage: {
      embedding: {
        createEmbedding: jest.fn(async (text: string) => {
          if (text && text.length > 0) {
            return new Array(3072).fill(1);
          }
          return new Array(3072).fill(0);
        }),
      } as unknown as number[],
    },
    kv: {
      addIssue: jest.fn(),
    },
  };
}
