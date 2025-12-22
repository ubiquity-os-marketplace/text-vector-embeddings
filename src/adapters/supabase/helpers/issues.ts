import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { cleanMarkdown, isTooShort, MIN_ISSUE_MARKDOWN_LENGTH } from "../../../utils/embedding-content";

export interface IssueType {
  id: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  deleted_at?: string | null;
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

export interface IssueWriteOptions {
  deferEmbedding?: boolean;
}

interface FindSimilarIssuesParams {
  markdown: string;
  currentId: string;
  threshold: number;
  topK?: number;
}

export class Issue extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = isShortIssue ? null : cleanedMarkdown;
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

    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const { data, error } = await this.supabase
      .from("issues")
      .insert([{ id: issueData.id, embedding, payload: finalPayload, author_id: issueData.author_id, markdown: finalMarkdown }]);
    if (error) {
      this.context.logger.error("Failed to create issue in database", {
        Error: error,
        issueData,
      });
      return;
    }
    this.context.logger.info(`Issue created successfully with id: ${issueData.id}`, { data });
  }

  async updateIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = isShortIssue ? null : cleanedMarkdown;
    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      embedding = Array.from(await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource));
    }
    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const issues = await this.getIssue(issueData.id);
    if (!issues || issues.length === 0) {
      this.context.logger.info("Issue does not exist, creating a new one");
      await this.createIssue({ ...issueData, markdown: finalMarkdown, payload: finalPayload, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
      return;
    }

    const { error } = await this.supabase
      .from("issues")
      .update({
        markdown: finalMarkdown,
        embedding,
        payload: finalPayload,
        modified_at: new Date(),
      })
      .eq("id", issueData.id);

    if (error) {
      this.context.logger.error("Error updating issue", {
        Error: error,
        issueData: {
          id: issueData.id,
          markdown: finalMarkdown,
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
        embedding,
        payload: finalPayload,
        modified_at: new Date(),
      },
    });
  }

  async getIssue(issueNodeId: string): Promise<IssueType[] | null> {
    const { data, error } = await this.supabase.from("issues").select("*").eq("id", issueNodeId).is("deleted_at", null);
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
    const { error } = await this.supabase
      .from("issues")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date().toISOString() })
      .eq("id", issueNodeId);
    if (error) {
      this.context.logger.error("Error deleting issue", { err: error });
      return;
    }
    this.context.logger.info("Issue deleted successfully with id: " + issueNodeId);
  }

  async findSimilarIssues({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.warn("Skipping issue similarity search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.warn("Skipping issue similarity search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }
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

  async findSimilarIssuesToMatch({ markdown, currentId, threshold, topK }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.warn("Skipping issue match search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.warn("Skipping issue match search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }
      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_issues_to_match", {
        current_id: currentId,
        query_embedding: embedding,
        threshold,
        top_k: topK ?? 5,
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
