import { ClientRateLimitInfo, ConfigType, Store } from "hono-rate-limiter";
import { PostgresPool, createPostgresPool } from "../adapters/postgres-driver";

type RateLimitRecord = {
  total_hits: number;
  reset_time: string | Date;
};

export class PostgresRateLimitStore implements Store {
  _options: ConfigType | undefined;
  private readonly _pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this._pool = pool;
  }

  async initialize() {
    const client = await this._pool.connect();

    try {
      await client.queryObject`
        CREATE TABLE IF NOT EXISTS rate_limit_records (
          key TEXT PRIMARY KEY,
          total_hits INTEGER NOT NULL,
          reset_time TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    } finally {
      client.release();
    }
  }

  init(options: ConfigType) {
    this._options = options;
  }

  async decrement(key: string) {
    const record = await this._getActiveRecord(key, Date.now());

    if (!record) {
      return;
    }

    await this._updateRecord(key, {
      totalHits: Math.max(0, record.totalHits - 1),
      resetTime: record.resetTime,
    });
  }

  async resetKey(key: string) {
    const client = await this._pool.connect();

    try {
      await client.queryObject`
        DELETE FROM rate_limit_records
        WHERE key = ${key}
      `;
    } finally {
      client.release();
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const nowMs = Date.now();
    const current = await this._getActiveRecord(key, nowMs);
    const payload: ClientRateLimitInfo = {
      totalHits: current ? current.totalHits + 1 : 1,
      resetTime: current?.resetTime ?? new Date(nowMs + (this._options?.windowMs ?? 60000)),
    };

    if (current) {
      await this._updateRecord(key, payload);
    } else {
      await this._upsertRecord(key, payload);
    }

    return payload;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this._getActiveRecord(key, Date.now());
  }

  async close(): Promise<void> {
    await this._pool.end();
  }

  private async _readRecord(key: string): Promise<ClientRateLimitInfo | undefined> {
    const client = await this._pool.connect();

    try {
      const result = await client.queryObject<RateLimitRecord>`
        SELECT total_hits, reset_time
        FROM rate_limit_records
        WHERE key = ${key}
      `;
      const row = result.rows[0];

      if (!row) {
        return undefined;
      }

      return {
        totalHits: row.total_hits,
        resetTime: new Date(row.reset_time),
      };
    } finally {
      client.release();
    }
  }

  private async _getActiveRecord(key: string, nowMs: number): Promise<ClientRateLimitInfo | undefined> {
    const record = await this._readRecord(key);

    if (!record) {
      return undefined;
    }

    const resetTime = record.resetTime;

    if (!resetTime) {
      return undefined;
    }

    if (resetTime.getTime() <= nowMs) {
      await this.resetKey(key);
      return undefined;
    }

    return {
      totalHits: record.totalHits,
      resetTime,
    };
  }

  private async _upsertRecord(key: string, payload: ClientRateLimitInfo): Promise<void> {
    const client = await this._pool.connect();
    const resetTime = payload.resetTime ?? new Date(Date.now() + (this._options?.windowMs ?? 60000));

    try {
      await client.queryObject`
        INSERT INTO rate_limit_records (key, total_hits, reset_time)
        VALUES (${key}, ${payload.totalHits}, ${resetTime.toISOString()})
        ON CONFLICT (key) DO UPDATE
        SET
          total_hits = EXCLUDED.total_hits,
          reset_time = EXCLUDED.reset_time,
          updated_at = NOW()
      `;
    } finally {
      client.release();
    }
  }

  private async _updateRecord(key: string, payload: ClientRateLimitInfo): Promise<void> {
    const client = await this._pool.connect();
    const resetTime = payload.resetTime ?? new Date(Date.now() + (this._options?.windowMs ?? 60000));

    try {
      await client.queryObject`
        UPDATE rate_limit_records
        SET
          total_hits = ${payload.totalHits},
          reset_time = ${resetTime.toISOString()},
          updated_at = NOW()
        WHERE key = ${key}
      `;
    } finally {
      client.release();
    }
  }
}

export class LazyPostgresRateLimitStore implements Store {
  private readonly _databaseUrl: string;
  private _options: ConfigType | undefined;
  private _storePromise: Promise<PostgresRateLimitStore> | null = null;

  constructor(databaseUrl: string) {
    this._databaseUrl = databaseUrl;
  }

  init(options: ConfigType) {
    this._options = options;
  }

  async decrement(key: string) {
    const store = await this._getStore();
    await store.decrement(key);
  }

  async resetKey(key: string) {
    const store = await this._getStore();
    await store.resetKey(key);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const store = await this._getStore();
    return store.increment(key);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const store = await this._getStore();
    return store.get(key);
  }

  private async _getStore(): Promise<PostgresRateLimitStore> {
    if (!this._storePromise) {
      this._storePromise = this._createStore();
    }

    return this._storePromise;
  }

  private async _createStore(): Promise<PostgresRateLimitStore> {
    const pool = await createPostgresPool(this._databaseUrl);
    const store = new PostgresRateLimitStore(pool);
    if (this._options) {
      store.init(this._options);
    }
    await store.initialize();
    return store;
  }
}

const rateLimitStores = new Map<string, LazyPostgresRateLimitStore>();

export function getSharedRateLimitStore(databaseUrl: string): LazyPostgresRateLimitStore {
  const existingStore = rateLimitStores.get(databaseUrl);

  if (existingStore) {
    return existingStore;
  }

  const store = new LazyPostgresRateLimitStore(databaseUrl);
  rateLimitStores.set(databaseUrl, store);
  return store;
}
