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

function parseUserLoginsFromTokens(tokens: string[]): string[] {
  return normalizeUserLogins(tokens);
}

function buildRecommendationComment(result: NonNullable<Awaited<ReturnType<typeof issueMatching>>>, requestedLogins: string[]): string {
  const formattedLogins = requestedLogins.map((login) => `@${login}`).join(", ");
  const lines: string[] = [">[!NOTE]", requestedLogins.length > 0 ? `>Recommendation results (filtered): ${formattedLogins}` : ">Recommendation results:"];

  if (!result.sortedContributors.length) {
    lines.push("> No suitable contributors found.");
    return lines.join("\n");
  }

  for (const { login, matches } of result.sortedContributors) {
    lines.push(`>### [${login}](https://www.github.com/${login})`);
    if (matches.length) {
      for (const match of matches.slice(0, 3)) {
        lines.push(match);
      }
    } else {
      lines.push("> No matches found.");
    }
  }

  return lines.join("\n");
}

async function postCommandResponse(context: Context<"issue_comment.created">, body: string, forceTag = false) {
  const options = forceTag ? { raw: true, commentKind: "command-response" } : { raw: true };
  await context.commentHandler.postComment(context, context.logger.info(body), options);
}

function parseCommentIdFromUrl(context: Context<"issue_comment.created">, commentUrl: string): string {
  const match = commentUrl.match(/#issuecomment-(\d+)$/);
  if (!match) {
    throw context.logger.error("Invalid comment URL");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(commentUrl);
  } catch {
    // Preserve legacy fragment-only support for current-repository comments.
    if (commentUrl.startsWith("/#issuecomment-")) {
      return match[1];
    }
    throw context.logger.error("Invalid comment URL");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    throw context.logger.error("Invalid comment URL");
  }

  const [owner, repo, resource, resourceId] = parsedUrl.pathname.split("/").filter(Boolean);
  if (!owner || !repo || (resource !== "issues" && resource !== "pull") || !resourceId) {
    throw context.logger.error("Invalid comment URL");
  }

  const currentOwner = context.payload.repository.owner.login;
  const currentRepo = context.payload.repository.name;
  const isCurrentRepository = owner.toLowerCase() === currentOwner.toLowerCase() && repo.toLowerCase() === currentRepo.toLowerCase();
  if (!isCurrentRepository) {
    const message =
      `Cannot annotate comment from ${owner}/${repo}. ` +
      `The comment URL must belong to the current repository ${currentOwner}/${currentRepo}; ` +
      "comments outside the current organization or without installation access cannot be annotated.";
    throw context.logger.error(message);
  }

  return match[1];
}

export async function commandHandler(context: Context<"issue_comment.created">) {
  if (!context.command) {
    return;
  }

  if (context.command.name === "annotate") {
    const commentUrl = context.command.parameters.commentUrl ?? null;
    const scope = context.command.parameters.scope ?? "org";
    let commentId = null;
    if (commentUrl) {
      commentId = parseCommentIdFromUrl(context, commentUrl);
    }
    await annotate(context, commentId, scope);
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

        commentId = parseCommentIdFromUrl(context, commentUrl);
      } else {
        throw logger.error("Invalid parameters");
      }
    }
    await annotate(context, commentId, scope);
  }

  if (commandName === "recommendation") {
    const requestedLogins = parseUserLoginsFromTokens(splitComment.slice(1));
    const result = requestedLogins.length > 0 ? await issueMatchingForUsers(context, requestedLogins) : await issueMatching(context);

    if (!result) {
      await postCommandResponse(context, ">[!NOTE]\n> No suitable contributors found.", true);
      return;
    }

    await postCommandResponse(context, buildRecommendationComment(result, requestedLogins), true);
  }
}
