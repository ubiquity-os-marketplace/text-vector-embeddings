import { Context } from "../types/context";
import { normalizeWhitespace, stripPluginUpdateComments } from "../utils/markdown-comments";
import { stripDuplicateFootnotes } from "../utils/footnotes";

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

  const { cleaned: oldBodyCleaned } = stripPluginUpdateComments(oldBody);
  const { cleaned: newBodyCleaned } = stripPluginUpdateComments(newBody);
  const oldBodyNormalized = stripDuplicateFootnotes(oldBodyCleaned);
  const newBodyNormalized = stripDuplicateFootnotes(newBodyCleaned);

  return normalizeWhitespace(oldBodyNormalized) === normalizeWhitespace(newBodyNormalized);
}

export function isBot(sender: { type: string; login?: string }) {
  return sender.type === "Bot";
}

export function isHumanUser(user?: { type?: string | null } | null): boolean {
  return user?.type === "User";
}
