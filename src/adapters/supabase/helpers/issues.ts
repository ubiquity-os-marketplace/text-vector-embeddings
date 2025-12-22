import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { markdownToPlainText } from "../../utils/markdown-to-plaintext";
import { stripHtmlComments } from "../../../utils/markdown-comments";
import { VOYAGE_EMBEDDING_MODEL } from "../../voyage/helpers/embedding";
import { enqueueEmbeddingJob, processEmbeddingQueue, shouldDeferEmbedding } from "../../../helpers/embedding-queue";

export interface IssueType {
  id: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  plaintext?: string | null;
  deleted_at?: string | null;
  embedding_status?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
}

export interface IssueSimilaritySearchResult {
  id: string;
  issue_id: string;
  similarity: number;
}

export interface IssueData {
  markdown: string | null;
  id: string;
  author_id: number;
  payload: Record<string, unknown> | null;
  isPrivate: boolean;
}

interface FindSimilarIssuesParams {
  markdown: string;
  currentId: string;
  threshold: number;
}

export class Issue extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createIssue(issueData: IssueData) {
    const { isPrivate } = issueData;
    //First Check if the issue already exists
    const { data: existingData, error: existingError } = await this.supabase.from("issues").select("*").eq("id", issueData.id);
    if (existingError) {
      this.context.logger.error("Error creating issue", {
        Error: existingError,
        issueData,
      });
      return;
    }
    if (existingData && existingData.length > 0) {
      this.context.logger.error("Issue already exists", {
        issueData: issueData,
      });
      return;
    }

    const shouldDefer = shouldDeferEmbedding(this.context, isPrivate);
    const embeddingSource = issueData.markdown ? stripHtmlComments(issueData.markdown) : issueData.markdown;
    const embedding = shouldDefer ? null : await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    let plaintext: string | null = markdownToPlainText(issueData.markdown);
    let finalMarkdown = issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
      plaintext = null;
    }

    const { data, error } = await this.supabase.from("issues").insert([
      {
        id: issueData.id,
        plaintext,
        embedding,
        embedding_status: embedding ? "ready" : "pending",
        embedding_model: embedding ? VOYAGE_EMBEDDING_MODEL : null,
        embedding_dim: embedding ? embedding.length : null,
        payload: finalPayload,
        author_id: issueData.author_id,
        markdown: finalMarkdown,
        deleted_at: null,
      },
    ]);
    if (error) {
      this.context.logger.error("Failed to create issue in database", {
        Error: error,
        issueData,
      });
      return;
    }
    this.context.logger.info(`Issue created successfully with id: ${issueData.id}`, { data });
    if (shouldDefer) {
      await enqueueEmbeddingJob(this.context, { table: "issues", id: issueData.id });
      await processEmbeddingQueue(this.context);
    }
  }

  async updateIssue(issueData: IssueData) {
    const { isPrivate } = issueData;
    const shouldDefer = shouldDeferEmbedding(this.context, isPrivate);
    const embeddingSource = issueData.markdown ? stripHtmlComments(issueData.markdown) : issueData.markdown;
    const embedding = shouldDefer ? null : Array.from(await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource));
    let plaintext: string | null = markdownToPlainText(issueData.markdown);
    let finalMarkdown = issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
      plaintext = null;
    }

    const issues = await this.getIssue(issueData.id);
    if (!issues || issues.length === 0) {
      this.context.logger.info("Issue does not exist, creating a new one");
      await this.createIssue({ ...issueData, markdown: finalMarkdown, payload: finalPayload, isPrivate });
      return;
    }

    const { error } = await this.supabase
      .from("issues")
      .update({
        markdown: finalMarkdown,
        plaintext,
        embedding,
        embedding_status: embedding ? "ready" : "pending",
        embedding_model: embedding ? VOYAGE_EMBEDDING_MODEL : null,
        embedding_dim: embedding ? embedding.length : null,
        payload: finalPayload,
        deleted_at: null,
        modified_at: new Date(),
      })
      .eq("id", issueData.id);

    if (error) {
      this.context.logger.error("Error updating issue", {
        Error: error,
        issueData: {
          id: issueData.id,
          markdown: finalMarkdown,
          plaintext,
          embedding,
          payload: finalPayload,
          modified_at: new Date(),
        },
      });
      return;
    }

    this.context.logger.info("Issue updated successfully with id: " + issueData.id, {
      issueData: {
        id: issueData.id,
        markdown: finalMarkdown,
        plaintext,
        embedding,
        payload: finalPayload,
        embedding_status: embedding ? "ready" : "pending",
        modified_at: new Date(),
      },
    });
    if (shouldDefer) {
      await enqueueEmbeddingJob(this.context, { table: "issues", id: issueData.id });
      await processEmbeddingQueue(this.context);
    }
  }

  async getIssue(issueNodeId: string): Promise<IssueType[] | null> {
    const { data, error } = await this.supabase.from("issues").select("*").eq("id", issueNodeId);
    if (error) {
      this.context.logger.error("Error getting issue", {
        Error: error,
        issueData: {
          id: issueNodeId,
        },
      });
      return null;
    }
    return data;
  }

  async deleteIssue(issueNodeId: string) {
    const { error } = await this.supabase.from("issues").update({ deleted_at: new Date().toISOString(), modified_at: new Date() }).eq("id", issueNodeId);
    if (error) {
      this.context.logger.error("Error deleting issue", { err: error });
      return;
    }
    this.context.logger.info("Issue deleted successfully with id: " + issueNodeId);
  }

  async updateEmbedding(issueNodeId: string, embedding: number[], model: string) {
    const { error } = await this.supabase
      .from("issues")
      .update({
        embedding,
        embedding_status: "ready",
        embedding_model: model,
        embedding_dim: embedding.length,
        modified_at: new Date(),
      })
      .eq("id", issueNodeId);
    if (error) {
      this.context.logger.error("Error updating issue embedding", { Error: error, issueId: issueNodeId });
    }
  }

  async markEmbeddingFailed(issueNodeId: string) {
    const { error } = await this.supabase.from("issues").update({ embedding_status: "failed", modified_at: new Date() }).eq("id", issueNodeId);
    if (error) {
      this.context.logger.error("Error marking issue embedding failed", { Error: error, issueId: issueNodeId });
    }
  }

  async findSimilarIssues({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = stripHtmlComments(markdown);
      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_issues_annotate", {
        query_embedding: embedding,
        current_id: currentId,
        threshold,
        top_k: 5,
      });
      if (error) {
        this.context.logger.error("Unable to find similar issues", {
          Error: error,
          markdown,
          currentId,
          threshold,
          query_embedding: embedding,
        });
        return null;
      }
      return data;
    } catch (error) {
      this.context.logger.error("Unable to find similar issues", {
        Error: error,
        markdown,
        currentId,
        threshold,
      });
      return null;
    }
  }

  async findSimilarIssuesToMatch({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = stripHtmlComments(markdown);
      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_issues_to_match", {
        current_id: currentId,
        query_embedding: embedding,
        threshold,
        top_k: 5,
      });
      if (error) {
        this.context.logger.error("Error finding similar issues", {
          Error: error,
          markdown,
          threshold,
          query_embedding: embedding,
        });
        return null;
      }
      return data;
    } catch (error) {
      this.context.logger.error("Error finding similar issues", {
        Error: error,
        markdown,
        threshold,
      });
      return null;
    }
  }
}
