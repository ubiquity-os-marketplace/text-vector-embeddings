import { Context } from "../types/index";
import { annotate } from "./annotate";
import { issueMatching, issueMatchingForUsers } from "./issue-matching";

// GitHub usernames are 1-39 chars, alphanumeric or hyphen, no leading/trailing hyphen.
const GITHUB_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function normalizeUserLogins(segments: string[]): string[] {
  return segments
    .flatMap((segment) => segment.split(","))
    .map((user) => user.trim().replace(/^@/, ""))
    .filter(Boolean)
    .filter((user) => GITHUB_LOGIN_REGEX.test(user));
}

// GitHub usernames cannot include whitespace or commas, so splitting is safe.
function parseUserLogins(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const segments = Array.isArray(value) ? value : [value];
  const expanded = segments.flatMap((segment) => segment.split(/\s+/));
  return normalizeUserLogins(expanded);
}

function parseUserLoginsFromTokens(tokens: string[]): string[] {
  return normalizeUserLogins(tokens);
}

function buildRecommendationComment(result: NonNullable<Awaited<ReturnType<typeof issueMatching>>>, requestedLogins: string[]): string {
  const formattedLogins = requestedLogins.map((login) => `@${login}`).join(", ");
  const lines: string[] = [">[!NOTE]", requestedLogins.length > 0 ? `>Recommendation results (filtered): ${formattedLogins}` : ">Recommendation results:"];

  if (!result.sortedContributors.length) {
    lines.push("> _No suitable contributors found._");
    return lines.join("\n");
  }

  for (const { login, matches } of result.sortedContributors) {
    lines.push(`>### [${login}](https://www.github.com/${login})`);
    if (matches.length) {
      for (const match of matches.slice(0, 3)) {
        lines.push(match);
      }
    } else {
      lines.push("> _No matches found._");
    }
  }

  return lines.join("\n");
}

export async function commandHandler(context: Context<"issue_comment.created">) {
  const { logger } = context;

  if (!context.command) {
    return;
  }

  if (context.command.name === "annotate") {
    const commentUrl = context.command.parameters.commentUrl ?? null;
    const scope = context.command.parameters.scope ?? "org";
    let commentId = null;
    if (commentUrl) {
      const commentRegex = /#issuecomment-(\d+)$/;
      const match = commentUrl.match(commentRegex);
      if (!match) {
        throw logger.error("Invalid comment URL");
      }
      commentId = match[1];
    }
    await annotate(context, commentId, scope);
  }

  if (context.command.name === "recommendation") {
    const issue = context.payload.issue;
    const { owner, name: repo } = context.payload.repository;
    const requestedLogins = parseUserLogins(context.command.parameters.users);
    const result = requestedLogins.length > 0 ? await issueMatchingForUsers(context, requestedLogins) : await issueMatching(context);

    if (!result) {
      await context.octokit.rest.issues.createComment({
        owner: owner.login,
        repo,
        issue_number: issue.number,
        body: ">[!NOTE]\n>_No suitable contributors found._",
      });
      return;
    }

    await context.octokit.rest.issues.createComment({
      owner: owner.login,
      repo,
      issue_number: issue.number,
      body: buildRecommendationComment(result, requestedLogins),
    });
  }
}

export async function userAnnotate(context: Context<"issue_comment.created">) {
  const { logger } = context;
  const comment = context.payload.comment;
  const splitComment = comment.body.trim().split(/\s+/);
  const commandName = splitComment[0].replace("/", "");

  let commentId = null;
  let scope = "org";

  if (commandName === "annotate") {
    if (splitComment.length > 1) {
      if (splitComment.length === 3) {
        const commentUrl = splitComment[1];
        scope = splitComment[2];

        if (scope !== "global" && scope !== "org" && scope !== "repo") {
          throw logger.error("Invalid scope");
        }

        const commentRegex = /#issuecomment-(\d+)$/;
        const match = commentUrl.match(commentRegex);
        if (!match) {
          throw logger.error("Invalid comment URL");
        }
        commentId = match[1];
      } else {
        throw logger.error("Invalid parameters");
      }
    }
    await annotate(context, commentId, scope);
  }

  if (commandName === "recommendation") {
    const issue = context.payload.issue;
    const { owner, name: repo } = context.payload.repository;
    const requestedLogins = parseUserLoginsFromTokens(splitComment.slice(1));
    const result = requestedLogins.length > 0 ? await issueMatchingForUsers(context, requestedLogins) : await issueMatching(context);

    if (!result) {
      await context.octokit.rest.issues.createComment({
        owner: owner.login,
        repo,
        issue_number: issue.number,
        body: ">[!NOTE]\n>_No suitable contributors found._",
      });
      return;
    }

    await context.octokit.rest.issues.createComment({
      owner: owner.login,
      repo,
      issue_number: issue.number,
      body: buildRecommendationComment(result, requestedLogins),
    });
  }
}
