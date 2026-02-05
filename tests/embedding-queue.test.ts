import { beforeEach, describe, expect, it, mock } from "bun:test";
import { SupabaseClient } from "@supabase/supabase-js";
import { processPendingEmbeddings, resetEmbeddingQueueRateLimits } from "../src/cron/embedding-queue";
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
  beforeEach(() => {
    resetEmbeddingQueueRateLimits();
  });
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

  it("does not clear markdown when rate limits persist for a single document", async () => {
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
    const { client, updates } = createMockSupabase([[reviewRow]]);
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

  it("splits batches on TPM limits and completes updates", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
      EMBEDDINGS_QUEUE_MAX_RETRIES: "0",
    } as Env;
    const issueRows: QueueRow[] = [
      {
        id: "issue-1",
        markdown: "a".repeat(6000),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-2",
        markdown: "b".repeat(6000),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
      {
        id: "issue-3",
        markdown: "c".repeat(6000),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      },
    ];
    const { client, updates } = createMockSupabase([issueRows, []]);
    let callCount = 0;
    const voyage = {
      embed: mock(async (payload: { input: string[] }) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error("rate limit") as Error & { statusCode?: number; body?: { detail?: string } };
          err.statusCode = 429;
          err.body = { detail: "10K TPM" };
          throw err;
        }
        return { data: payload.input.map(() => ({ embedding: [1, 2, 3] })) };
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(3);
    expect(result.commentsProcessed).toBe(0);
    expect(result.stoppedEarly).toBe(false);
    expect(updates.length).toBe(3);
    expect(updates.every((update) => update.values.embedding_status === "ready")).toBe(true);
  });

  it("splits batches using RPM-aware request budgets", async () => {
    const env = {
      EMBEDDINGS_QUEUE_ENABLED: "true",
      EMBEDDINGS_QUEUE_DELAY_MS: "0",
      EMBEDDINGS_QUEUE_MAX_RETRIES: "0",
    } as Env;
    const issueRows: QueueRow[] = [];
    for (let index = 0; index < 4; index += 1) {
      issueRows.push({
        id: `issue-${index + 1}`,
        markdown: "a".repeat(2000),
        modified_at: new Date().toISOString(),
        payload: { issue: { user: { type: "User" } } },
        doc_type: "issue",
      });
    }
    const { client, updates } = createMockSupabase([issueRows, []]);
    let callCount = 0;
    const voyage = {
      embed: mock(async (payload: { input: string[] }) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error("rate limit") as Error & { statusCode?: number; body?: { detail?: string } };
          err.statusCode = 429;
          err.body = { detail: "3 RPM and 10K TPM" };
          throw err;
        }
        return { data: payload.input.map(() => ({ embedding: [1, 2, 3] })) };
      }),
    };

    const result = await processPendingEmbeddings({
      env,
      clients: { supabase: client, voyage: voyage as never },
      logger: createLogger(),
    });

    expect(result.issuesProcessed).toBe(4);
    expect(result.stoppedEarly).toBe(false);
    expect(updates.length).toBe(4);
    const callInputs = voyage.embed.mock.calls.map((call) => call[0]?.input?.length ?? 0);
    expect(callInputs[0]).toBe(4);
    expect(callInputs.slice(1)).toEqual([2, 2]);
  });
});
