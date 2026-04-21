import { afterEach, describe, expect, it } from "bun:test";
import { PostgresRateLimitStore } from "../src/helpers/rate-limiter";
import { createMockPostgresPool } from "./helpers/mock-postgres";

const originalDateNow = Date.now;

describe("PostgresRateLimitStore", () => {
  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("increments within an active window and resets expired records", async () => {
    const { pool, state } = createMockPostgresPool();
    const store = new PostgresRateLimitStore(pool);
    await store.initialize();
    store.init({ windowMs: 1000 } as never);

    Date.now = () => 1_000;
    const first = await store.increment("127.0.0.1");
    expect(first.totalHits).toBe(1);
    expect(first.resetTime.toISOString()).toBe(new Date(2_000).toISOString());

    Date.now = () => 1_500;
    const second = await store.increment("127.0.0.1");
    expect(second.totalHits).toBe(2);
    expect(second.resetTime.toISOString()).toBe(first.resetTime.toISOString());

    await store.decrement("127.0.0.1");
    const current = await store.get("127.0.0.1");
    expect(current).toEqual({
      totalHits: 1,
      resetTime: new Date(2_000),
    });

    Date.now = () => 2_500;
    expect(await store.get("127.0.0.1")).toBeUndefined();
    expect(state.rateLimitRecords.has("127.0.0.1")).toBe(false);

    const reset = await store.increment("127.0.0.1");
    expect(reset.totalHits).toBe(1);
    expect(reset.resetTime.toISOString()).toBe(new Date(3_500).toISOString());
  });

  it("resets keys and closes the pool", async () => {
    const { pool, state } = createMockPostgresPool();
    const store = new PostgresRateLimitStore(pool);
    await store.initialize();
    store.init({ windowMs: 1000 } as never);

    Date.now = () => 1_000;
    await store.increment("key");
    await store.resetKey("key");
    expect(await store.get("key")).toBeUndefined();

    await store.close();
    expect(state.ended).toBe(true);
  });
});
