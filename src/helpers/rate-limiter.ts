import { ClientRateLimitInfo, ConfigType, Store } from "hono-rate-limiter";

export class KvStore implements Store {
  _options: ConfigType | undefined;
  prefix = "rate-limiter";

  constructor(readonly _store: Deno.Kv) {}

  init(options: ConfigType) {
    this._options = options;
  }

  async decrement(key: string) {
    const nowMs = Date.now();
    const record = await this.get(key);

    const existingResetTimeMs = record?.resetTime && new Date(record.resetTime).getTime();
    const isActiveWindow = existingResetTimeMs && existingResetTimeMs > nowMs;

    if (isActiveWindow && record) {
      const payload: ClientRateLimitInfo = {
        totalHits: Math.max(0, record.totalHits - 1),
        resetTime: new Date(existingResetTimeMs),
      };

      await this.updateRecord(key, payload);
    }
  }

  async resetKey(key: string) {
    await this._store.delete([this.prefix, key]);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const nowMs = Date.now();
    const record = await this.get(key);
    const defaultResetTime = new Date(nowMs + (this._options?.windowMs ?? 60000));

    const existingResetTimeMs = record?.resetTime && new Date(record.resetTime).getTime();
    const isActiveWindow = existingResetTimeMs && existingResetTimeMs > nowMs;

    const payload: ClientRateLimitInfo = {
      totalHits: isActiveWindow ? record.totalHits + 1 : 1,
      resetTime: isActiveWindow && existingResetTimeMs ? new Date(existingResetTimeMs) : defaultResetTime,
    };

    await this.updateRecord(key, payload);

    return payload;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const res = await this._store.get<ClientRateLimitInfo>([this.prefix, key]);
    return res?.value ?? undefined;
  }

  async updateRecord(key: string, payload: ClientRateLimitInfo): Promise<void> {
    await this._store.set([this.prefix, key], payload);
  }
}
