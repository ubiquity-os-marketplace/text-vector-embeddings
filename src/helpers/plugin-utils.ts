import pkg from "../../package.json" with { type: "json" };
import { Context } from "../types/context";

export function isPluginEdit(context: Context<"issues.edited">) {
  if (!isBot(context.payload.sender)) {
    return false;
  }

  const changes = context.payload.changes;
  if (!changes?.body?.from) {
    return false;
  }

  const oldBody = changes.body.from;
  const newBody = context.payload.issue.body || "";

  const diff = newBody.replace(oldBody, "").trim();

  const pluginCommentPattern = new RegExp(`<!-- ${pkg.name} update .*-->$`);

  return pluginCommentPattern.test(diff);
}

export function isBot(sender: { type: string; login?: string }) {
  return sender.type === "Bot";
}
