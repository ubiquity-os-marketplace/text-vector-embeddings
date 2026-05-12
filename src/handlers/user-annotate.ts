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

function parseGitHubCommentUrl(commentUrl: string): { owner: string; repo: string; commentId: string } | null {
  const match = commentUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    commentId: match[3],
  };
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
    let commentRepo;
    if (commentUrl) {
      const parsedComment = parseGitHubCommentUrl(commentUrl);
      if (!parsedComment) {
        throw logger.error("Invalid comment URL");
      }
      commentId = parsedComment.commentId;
      commentRepo = { owner: parsedComment.owner, repo: parsedComment.repo };
    }
    await annotate(context, commentId, scope, commentRepo);
  }
}

export async function userAnnotate(context: Context<"issue_comment.created">) {
  const { logger } = context;
  const comment = context.payload.comment;
  const splitComment = comment.body.trim().split(/\s+/);
  const commandName = splitComment[0].replace("/", "");

  let commentId = null;
  let scope = "org";
  let commentRepo;

  if (commandName === "annotate") {
    if (splitComment.length > 1) {
      if (splitComment.length === 3) {
        const commentUrl = splitComment[1];
        scope = splitComment[2];

        if (scope !== "global" && scope !== "org" && scope !== "repo") {
          throw logger.error("Invalid scope");
        }

        const parsedComment = parseGitHubCommentUrl(commentUrl);
        if (!parsedComment) {
          throw logger.error("Invalid comment URL");
        }
        commentId = parsedComment.commentId;
        commentRepo = { owner: parsedComment.owner, repo: parsedComment.repo };
      } else {
        throw logger.error("Invalid parameters");
      }
    }
    await annotate(context, commentId, scope, commentRepo);
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
