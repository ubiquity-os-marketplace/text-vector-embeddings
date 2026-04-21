import { afterEach, describe, expect, it, mock } from "bun:test";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { updateCronState } from "../src/cron/workflow";
import type { Context } from "../src/types/index";

function createContext(options: { hasTrackedIssues: boolean; hasPendingEmbeddings: boolean }): Context {
  const enableWorkflow = mock(async () => {});
  const disableWorkflow = mock(async () => {});

  return {
    eventName: "issues.opened",
    command: null,
    authToken: "",
    commentHandler: {} as Context["commentHandler"],
    payload: {} as Context["payload"],
    config: {} as Context["config"],
    logger: new Logs("debug") as unknown as Context["logger"],
    env: {
      DATABASE_URL: "postgres://db.example/text-vector-embeddings",
      EMBEDDINGS_QUEUE_ENABLED: "true",
    } as Context["env"],
    octokit: {
      rest: {
        actions: {
          enableWorkflow,
          disableWorkflow,
        },
      },
    } as unknown as Context["octokit"],
    adapters: {
      issueStore: {
        hasData: mock(async () => options.hasTrackedIssues),
      },
      supabase: {
        super: {
          hasPendingEmbeddings: mock(async () => options.hasPendingEmbeddings),
        },
      },
    } as unknown as Context["adapters"],
  };
}

describe("updateCronState", () => {
  afterEach(() => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.APP_ID;
    delete process.env.APP_PRIVATE_KEY;
    mock.restore();
  });

  it("enables cron when tracked issues exist", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    const context = createContext({ hasTrackedIssues: true, hasPendingEmbeddings: false });

    await updateCronState(context);

    expect(context.octokit.rest.actions.enableWorkflow).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      workflow_id: "cron.yml",
    });
    expect(context.octokit.rest.actions.disableWorkflow).not.toHaveBeenCalled();
  });

  it("disables cron when neither tracked issues nor pending embeddings exist", async () => {
    process.env.GITHUB_REPOSITORY = "acme/widgets";
    const context = createContext({ hasTrackedIssues: false, hasPendingEmbeddings: false });

    await updateCronState(context);

    expect(context.octokit.rest.actions.disableWorkflow).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      workflow_id: "cron.yml",
    });
    expect(context.octokit.rest.actions.enableWorkflow).not.toHaveBeenCalled();
  });
});
