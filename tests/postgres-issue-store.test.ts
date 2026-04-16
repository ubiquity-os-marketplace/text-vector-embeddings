import { describe, expect, it } from "bun:test";
import { PostgresIssueStore } from "../src/adapters/postgres-issue-store";
import { createMockPostgresPool } from "./helpers/mock-postgres";

const owner = "acme";
const widgetsIssueTwoUrl = "https://github.com/acme/widgets/issues/2";
const widgetsIssueOneUrl = "https://github.com/acme/widgets/issues/1";
const apiIssueUrl = "https://github.com/acme/api/issues/7";
const platformIssueUrl = "https://github.com/acme/platform/issues/9";

describe("PostgresIssueStore", () => {
  it("supports tracked issue CRUD with stable repository grouping", async () => {
    const { pool } = createMockPostgresPool();
    const issueStore = new PostgresIssueStore(pool);
    await issueStore.initialize();

    await issueStore.addIssue(widgetsIssueTwoUrl);
    await issueStore.addIssue(widgetsIssueOneUrl);
    await issueStore.addIssue(apiIssueUrl);
    await issueStore.addIssue(widgetsIssueTwoUrl);

    expect(await issueStore.hasData()).toBe(true);
    expect(await issueStore.getIssueNumbers(owner, "widgets")).toEqual([1, 2]);
    expect(await issueStore.getAllRepositories()).toEqual([
      { owner, repo: "api", issueNumbers: [7] },
      { owner, repo: "widgets", issueNumbers: [1, 2] },
    ]);

    await issueStore.updateIssue(widgetsIssueTwoUrl, platformIssueUrl);
    expect(await issueStore.getAllRepositories()).toEqual([
      { owner, repo: "api", issueNumbers: [7] },
      { owner, repo: "platform", issueNumbers: [9] },
      { owner, repo: "widgets", issueNumbers: [1] },
    ]);

    await issueStore.removeIssue(widgetsIssueOneUrl);
    await issueStore.removeIssue(apiIssueUrl);
    await issueStore.removeIssue(platformIssueUrl);

    expect(await issueStore.hasData()).toBe(false);
    expect(await issueStore.getAllRepositories()).toEqual([]);
  });

  it("closes the Postgres pool", async () => {
    const { pool, state } = createMockPostgresPool();
    const issueStore = new PostgresIssueStore(pool);

    await issueStore.close();

    expect(state.ended).toBe(true);
  });
});
