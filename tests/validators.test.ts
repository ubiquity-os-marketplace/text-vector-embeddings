import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { urlSchema } from "../src/validators";

describe("urlSchema", () => {
  it("accepts user-copied GitHub issue and pull request URLs", () => {
    expect(v.parse(urlSchema, "https://github.com/owner/repo/issues/123/")).toBe("https://github.com/owner/repo/issues/123/");
    expect(v.parse(urlSchema, "https://www.github.com/owner/repo/pull/456?notification_referrer_id=abc#discussion_r1")).toBe(
      "https://www.github.com/owner/repo/pull/456?notification_referrer_id=abc#discussion_r1"
    );
  });

  it("rejects non-issue GitHub URLs", () => {
    expect(() => v.parse(urlSchema, "https://github.com/owner/repo/tree/main")).toThrow();
  });
});
