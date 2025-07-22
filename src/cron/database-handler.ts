import { parseGitHubUrl } from "../helpers/github";

export const KV_PREFIX = "cron";

export class CronDatabase {
  private _kv: Deno.Kv;

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

  async getAllRepositories(): Promise<Array<{ owner: string; repo: string; issueNumbers: number[] }>> {
    const repositories: Array<{ owner: string; repo: string; issueNumbers: number[] }> = [];
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
  return new CronDatabase(kv);
}
