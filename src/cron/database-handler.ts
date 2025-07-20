export const KV_PREFIX = "cron";

export class CronDatabase {
  private _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  async getIssueIds(organization: string, repository: string): Promise<number[]> {
    const key = [KV_PREFIX, organization, repository];
    const result = await this._kv.get<number[]>(key);
    return result.value || [];
  }

  async addIssueId(organization: string, repository: string, issueId: number): Promise<void> {
    const key = [KV_PREFIX, organization, repository];
    const currentIds = await this.getIssueIds(organization, repository);

    if (!currentIds.includes(issueId)) {
      currentIds.push(issueId);
      await this._kv.set(key, currentIds);
    }
  }

  async removeIssueId(organization: string, repository: string, issueId: number): Promise<void> {
    const key = [KV_PREFIX, organization, repository];
    const currentIds = await this.getIssueIds(organization, repository);
    const filteredIds = currentIds.filter((id) => id !== issueId);

    if (filteredIds.length === 0) {
      await this._kv.delete(key);
    } else {
      await this._kv.set(key, filteredIds);
    }
  }

  async getAllRepositories(): Promise<Array<{ organization: string; repository: string; issueIds: number[] }>> {
    const repositories: Array<{ organization: string; repository: string; issueIds: number[] }> = [];
    const iter = this._kv.list({ prefix: [KV_PREFIX] });

    for await (const entry of iter) {
      if (entry.key.length >= 3) {
        const organization = entry.key[1] as string;
        const repository = entry.key[2] as string;
        const issueIds = entry.value as number[];
        repositories.push({ organization, repository, issueIds });
      }
    }

    return repositories;
  }
}

export async function createCronDatabase(): Promise<CronDatabase> {
  const kv = await Deno.openKv();
  return new CronDatabase(kv);
}
