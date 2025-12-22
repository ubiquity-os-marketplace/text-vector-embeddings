import { Context } from "../types/index";
import { getEmbeddingQueueSettings } from "../utils/embedding-queue";

type ReviewContext = Context<"pull_request_review_comment.created" | "pull_request_review_comment.edited" | "pull_request_review_comment.deleted">;

type PullRequestPayload = {
  node_id?: string | null;
  title?: string | null;
  body?: string | null;
  user?: { id?: number | null; login?: string | null; type?: string | null } | null;
  html_url?: string | null;
};

function buildPullRequestMarkdown(pullRequest: PullRequestPayload): string | null {
  const body = pullRequest.body?.trim() ?? "";
  const title = pullRequest.title?.trim() ?? "";
  const combined = [body, title].filter(Boolean).join(" ").trim();
  return combined || null;
}

export async function ensurePullRequestIssue(context: ReviewContext, pullRequest: PullRequestPayload): Promise<string | null> {
  const {
    logger,
    adapters: { supabase },
    payload,
    config,
  } = context;

  const id = pullRequest.node_id ?? "";
  if (!id) {
    logger.error("Pull request node_id is missing; cannot link review comment");
    return null;
  }

  const existing = await supabase.issue.getIssue(id);
  if (existing && existing.length > 0) {
    return id;
  }

  const authorType = pullRequest.user?.type ?? null;
  const isHumanAuthor = authorType === "User";
  const markdown = isHumanAuthor ? buildPullRequestMarkdown(pullRequest) : null;

  if (!isHumanAuthor) {
    logger.debug("Pull request author is not human; storing issue without embeddings.", {
      author: pullRequest.user?.login ?? null,
      type: authorType,
      pullRequestUrl: pullRequest.html_url,
    });
  }

  if (isHumanAuthor && !markdown) {
    logger.error("Pull request title/body is empty; skipping PR issue creation", { pullRequestUrl: pullRequest.html_url });
    return id;
  }

  if (config.demoFlag) {
    logger.info("Demo mode active - skipping PR issue storage", { pullRequestUrl: pullRequest.html_url });
    return id;
  }

  const authorId = pullRequest.user?.id ?? -1;
  const isPrivate = payload.repository?.private ?? false;
  const queueSettings = getEmbeddingQueueSettings(context.env);

  await supabase.issue.createIssue(
    {
      id,
      payload: payload as Record<string, unknown>,
      isPrivate,
      markdown,
      author_id: authorId,
    },
    { deferEmbedding: queueSettings.enabled }
  );

  logger.info("Created PR issue entry for review comment linkage", { id, pullRequestUrl: pullRequest.html_url });
  return id;
}
