import { describe, expect, it, mock } from "bun:test";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import type { Context } from "../src/types/index";

function createContext(events: string[]): Context<"issues.opened"> {
  return {
    eventName: "issues.opened",
    command: null,
    authToken: "",
    commentHandler: {} as Context<"issues.opened">["commentHandler"],
    payload: {
      issue: {
        node_id: "ISSUE_1",
        html_url: "https://github.com/acme/widgets/issues/1",
        body: "Issue body",
        title: "Issue title",
        user: { id: 1, type: "User", login: "alice" },
        number: 1,
      },
      repository: {
        private: false,
        name: "widgets",
        owner: { login: "acme" },
      },
    } as Context<"issues.opened">["payload"],
    config: {
      demoFlag: false,
    } as Context<"issues.opened">["config"],
    logger: new Logs("debug") as unknown as Context<"issues.opened">["logger"],
    env: {
      DATABASE_URL: "postgres://db.example/text-vector-embeddings",
      EMBEDDINGS_QUEUE_ENABLED: "true",
    } as Context<"issues.opened">["env"],
    octokit: {} as Context<"issues.opened">["octokit"],
    adapters: {
      supabase: {
        issue: {
          createIssue: mock(async () => {
            events.push("createIssue");
          }),
        },
      },
      issueStore: {
        addIssue: mock(async () => {
          events.push("issueStore.addIssue");
        }),
      },
      close: mock(async () => {
        events.push("close");
      }),
    } as unknown as Context<"issues.opened">["adapters"],
  };
}

describe("runPlugin lifecycle", () => {
  it("closes adapters after completing the handler path", async () => {
    const events: string[] = [];
    const { runPlugin } = await import(`../src/plugin?t=${Date.now()}`);
    const context = createContext(events);

    await runPlugin(context);

    expect(events).toEqual(["createIssue", "issueStore.addIssue", "close"]);
  });
});
