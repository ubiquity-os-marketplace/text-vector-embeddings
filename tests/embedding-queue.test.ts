import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { processEmbeddingQueue, enqueueEmbeddingJob } from "../src/helpers/embedding-queue";
import type { Context } from "../src/types/context";

type KvEntry = { key: Deno.KvKey; value: unknown };
type KvStore = {
  list: (selector: { prefix: Deno.KvKey }) => AsyncIterable<KvEntry>;
  set: (key: Deno.KvKey, value: unknown) => Promise<void>;
  delete: (key: Deno.KvKey) => Promise<void>;
};

function createKvStore() {
  const entries: KvEntry[] = [];

  async function* list({ prefix }: { prefix: Deno.KvKey }) {
    const sorted = [...entries].sort((a, b) => (Number(a.key[1]) || 0) - (Number(b.key[1]) || 0));
    for (const entry of sorted) {
      if (Array.isArray(entry.key) && entry.key[0] === prefix[0]) {
        yield entry;
      }
    }
  }

  return {
    store: entries,
    kv: {
      list,
      set: async (key: Deno.KvKey, value: unknown) => {
        entries.push({ key, value });
      },
      delete: async (key: Deno.KvKey) => {
        const keyId = JSON.stringify(key);
        const index = entries.findIndex((entry) => JSON.stringify(entry.key) === keyId);
        if (index >= 0) entries.splice(index, 1);
      },
    } as KvStore,
  };
}

describe("embedding queue", () => {
  const globalAny = globalThis as unknown as { Deno?: { openKv?: (path?: string) => Promise<KvStore> } };
  const originalDeno = globalAny.Deno;

  beforeEach(() => {
    const { kv } = createKvStore();
    globalAny.Deno = {
      openKv: async () => kv,
    };
  });

  afterEach(() => {
    if (originalDeno) {
      globalAny.Deno = originalDeno;
    } else {
      delete globalAny.Deno;
    }
  });

  it("processes queued issue embeddings", async () => {
    const updateEmbedding = mock();
    const markEmbeddingFailed = mock();
    const getIssue = mock(async () => [
      {
        markdown: "Queued issue body",
        embedding_status: "pending",
        embedding: null,
        deleted_at: null,
      },
    ]);
    const getComment = mock();

    const context = {
      config: {
        embeddingMode: "async",
        embeddingQueueMaxPerRun: 1,
        embeddingQueueDelaySeconds: 1,
        embeddingQueueMaxAttempts: 1,
      },
      adapters: {
        supabase: {
          issue: {
            getIssue,
            updateEmbedding,
            markEmbeddingFailed,
          },
          comment: {
            getComment,
            updateEmbedding: mock(),
            markEmbeddingFailed: mock(),
          },
        },
        voyage: {
          embedding: {
            createEmbedding: mock(async () => [1, 2, 3]),
          },
        },
      },
      logger: {
        debug: mock(),
        error: mock(),
      },
    } as unknown as Context;

    await enqueueEmbeddingJob(context, { table: "issues", id: "issue-queued" });
    await processEmbeddingQueue(context);

    expect(updateEmbedding).toHaveBeenCalled();
    expect(updateEmbedding.mock.calls[0][0]).toBe("issue-queued");
  });
});
