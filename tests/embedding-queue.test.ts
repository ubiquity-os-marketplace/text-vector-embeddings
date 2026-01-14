import { describe, expect, it, mock } from "bun:test";
import { SupabaseClient } from "@supabase/supabase-js";
import { processPendingEmbeddings } from "../src/cron/embedding-queue";
import { Database } from "../src/types/database";
import { Env } from "../src/types/index";

type QueueRow = {
  id: string;
  markdown: string | null;
  modified_at: string;
  payload: Record<string, unknown> | null;
  doc_type: string;
};

function createMockSupabase(selectBatches: QueueRow[][]) {
  const capturedDocTypes: string[][] = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  let selectCall = 0;

  const selectBuilder = {
    in: (field: string, docTypes: string[]) => {
      void field;
      capturedDocTypes.push(docTypes);
      return selectBuilder;
    },
    is: () => selectBuilder,
    not: () => selectBuilder,
    order: () => selectBuilder,
    limit: async () => ({
      data: selectBatches[selectCall++] ?? [],
      error: null,
    }),
  };

  const client = {
    from: (table: string) => {
      void table;
      return {
        select: (columns?: string) => {
          void columns;
          return selectBuilder;
        },
        update: (values: Record<string, unknown>) => ({
          eq: async (field: string, id: string) => {
            void field;
            updates.push({ id, values });
            return { error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, capturedDocTypes, updates };
}

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

describe("processPendingEmbeddings", () => {
  it("processes pull request documents with issue-length thresholds", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;
    const prRow: QueueRow = {
      id: "pr-1",
      markdown: "x".repeat(40),
      modified_at: new Date().toISOString(),
      payload: { pull_request: { user: { type: "User" } } },
      doc_type: "pull_request",
    };
    const { client, capturedDocTypes, updates } = createMockSupabase([[prRow], []]);
    const voyage = {
      embed: mock(async () => ({ data: [{ embedding: [1, 2, 3] }] })),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(1);
    expect(result.commentsProcessed).toBe(0);
    expect(result.stoppedEarly).toBe(false);
    expect(capturedDocTypes[0]).toContain("pull_request");
    expect(updates.length).toBe(1);
  });

  it("marks the queue as stopped when rate limits persist", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
      EMBEDDINGS_QUEUE_MAX_RETRIES: "0",
    } as Env;
    const issueRow: QueueRow = {
      id: "issue-1",
      markdown: "y".repeat(80),
      modified_at: new Date().toISOString(),
      payload: { issue: { user: { type: "User" } } },
      doc_type: "issue",
    };
    const { client, updates } = createMockSupabase([[issueRow], []]);
    const voyage = {
      embed: mock(async () => {
        throw new Error("rate limit exceeded");
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(0);
    expect(result.stoppedEarly).toBe(true);
    expect(updates.length).toBe(0);
  });

  it("allows bot-authored root review comments through the queue", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
    } as Env;
    const reviewRow: QueueRow = {
      id: "review-root",
      markdown: "z".repeat(80),
      modified_at: new Date().toISOString(),
      payload: { comment: { user: { type: "Bot" }, in_reply_to_id: null } },
      doc_type: "review_comment",
    };
    const { client, updates } = createMockSupabase([[], [reviewRow]]);
    const voyage = {
      embed: mock(async () => ({ data: [{ embedding: [1, 2, 3] }] })),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.commentsProcessed).toBe(1);
    expect(updates.length).toBe(1);
  });
});
