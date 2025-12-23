import { parseGitHubUrl } from "../helpers/github";

export const KV_PREFIX = "cron";

export type CronRepositoryEntry = { owner: string; repo: string; issueNumbers: number[] };

export interface CronDatabase {
  getIssueNumbers(owner: string, repo: string): Promise<number[]>;
  addIssue(url: string): Promise<void>;
  removeIssue(url: string): Promise<void>;
  updateIssue(currentUrl: string, newUrl: string): Promise<void>;
  getAllRepositories(): Promise<CronRepositoryEntry[]>;
}

class DenoCronDatabase implements CronDatabase {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  async getIssueNumbers(owner: string, repo: string): Promise<number[]> {
    const key = [KV_PREFIX, owner, repo];
    const result = await this._kv.get<number[]>(key);
    return result.value || [];
  }

  async addIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = [KV_PREFIX, owner, repo];
    const currentIds = await this.getIssueNumbers(owner, repo);

    if (!currentIds.includes(issue_number)) {
      currentIds.push(issue_number);
      await this._kv.set(key, currentIds);
    }
  }

  async removeIssue(url: string): Promise<void> {
    const { owner, repo, issue_number } = parseGitHubUrl(url);
    const key = [KV_PREFIX, owner, repo];
    const currentNumbers = await this.getIssueNumbers(owner, repo);
    const filteredNumbers = currentNumbers.filter((id) => id !== issue_number);

    if (filteredNumbers.length === 0) {
      await this._kv.delete(key);
    } else {
      await this._kv.set(key, filteredNumbers);
    }
  }

  async updateIssue(currentUrl: string, newUrl: string): Promise<void> {
    await this.removeIssue(currentUrl);
    await this.addIssue(newUrl);
  }

  async getAllRepositories(): Promise<CronRepositoryEntry[]> {
    const repositories: CronRepositoryEntry[] = [];
    const iter = this._kv.list({ prefix: [KV_PREFIX] });

    for await (const entry of iter) {
      if (entry.key.length >= 3) {
        const owner = entry.key[1] as string;
        const repo = entry.key[2] as string;
        const issueNumbers = entry.value as number[];
        repositories.push({ owner, repo, issueNumbers });
      }
    }

    return repositories;
  }
}

export async function createCronDatabase(): Promise<CronDatabase> {
  const kv = await Deno.openKv(process.env.DENO_KV_URL);
  return new DenoCronDatabase(kv);
}
