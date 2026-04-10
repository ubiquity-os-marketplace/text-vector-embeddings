import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { IssueDocumentType, ISSUE_DOCUMENT_TYPES } from "../../../types/document";
import { serializeEmbeddingForDatabase } from "../../../utils/database-embedding";
import { cleanMarkdown, isTooShort, MIN_ISSUE_MARKDOWN_LENGTH } from "../../../utils/embedding-content";
import { PluginSettings } from "../../../types/plugin-input";

export interface IssueType {
  id: string;
  doc_type?: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  nomic_embedding: number[] | null;
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
  docType?: IssueDocumentType;
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

function resolveIssueDocType(payload: IssueData["payload"], explicitType?: IssueDocumentType): IssueDocumentType {
  if (explicitType) {
    return explicitType;
  }
  if (payload && typeof payload === "object") {
    const hasIssue = "issue" in payload;
    const hasPullRequest = "pull_request" in payload;
    if (hasPullRequest && !hasIssue) {
      return "pull_request";
    }
  }
  return "issue";
}

function getEmbeddingModel(context: Context): "voyage" | "nomic" {
  const config = context.config as PluginSettings | undefined;
  return config?.embeddingModel ?? "voyage";
}

function isNomicAvailable(context: Context): boolean {
  return !!context.env.NOMIC_API_KEY;
}

export class Issue extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = resolveIssueDocType(issueData.payload, issueData.docType);
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;

    // First Check if the issue already exists
    const { data: existingData, error: existingError } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", issueData.id)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error creating issue", {
        Error: existingError,
        issueData,
      });
      return;
    }
    if (existingData && existingData.length > 0) {
      this.context.logger.warn("Issue already exists", {
        issueData: issueData,
      });
      return;
    }

    // Create embeddings for this issue
    let embedding: number[] | null = null;
    let nomicEmbedding: number[] | null = null;

    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      // Always create Voyage embedding
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);

      // Create Nomic embedding if API key is available
      if (isNomicAvailable(this.context)) {
        try {
          nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource);
        } catch (nomicError) {
          this.context.logger.warn("Failed to create Nomic embedding, continuing with Voyage only.", {
            Error: nomicError instanceof Error ? nomicError : new Error(String(nomicError)),
            issueId: issueData.id,
          });
        }
      }
    }

    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const insertData: Record<string, unknown> = {
      id: issueData.id,
      doc_type: docType,
      parent_id: null,
      embedding: serializeEmbeddingForDatabase(embedding),
      payload: finalPayload,
      author_id: issueData.author_id,
      markdown: finalMarkdown,
    };

    // Only add nomic_embedding if it was successfully created
    if (nomicEmbedding) {
      insertData.nomic_embedding = serializeEmbeddingForDatabase(nomicEmbedding);
    }

    const { data, error } = await this.supabase.from("documents").insert([insertData]);
    if (error) {
      this.context.logger.error("Failed to create issue in database", {
        Error: error,
        issueData,
      });
      return;
    }
    this.context.logger.ok(`Issue created successfully with id: ${issueData.id}`, { data });
  }

  async updateIssue(issueData: IssueData, options: IssueWriteOptions = {}) {
    const { isPrivate } = issueData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = resolveIssueDocType(issueData.payload, issueData.docType);
    const cleanedMarkdown = cleanMarkdown(issueData.markdown);
    const isShortIssue = isTooShort(cleanedMarkdown, MIN_ISSUE_MARKDOWN_LENGTH);
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;

    // Create embeddings for this issue
    let embedding: number[] | null = null;
    let nomicEmbedding: number[] | null = null;

    if (!shouldDeferEmbedding && embeddingSource && !isPrivate) {
      // Always create Voyage embedding
      embedding = Array.from(await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource));

      // Create Nomic embedding if API key is available
      if (isNomicAvailable(this.context)) {
        try {
          nomicEmbedding = Array.from(await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource));
        } catch (nomicError) {
          this.context.logger.warn("Failed to create Nomic embedding during update, continuing with Voyage only.", {
            Error: nomicError instanceof Error ? nomicError : new Error(String(nomicError)),
            issueId: issueData.id,
          });
        }
      }
    }

    let finalMarkdown = isShortIssue ? null : issueData.markdown;
    let finalPayload = issueData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const issues = await this.getIssue(issueData.id);
    if (!issues || issues.length === 0) {
      this.context.logger.debug("Issue does not exist, creating a new one");
      await this.createIssue({ ...issueData, markdown: finalMarkdown, payload: finalPayload, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
      return;
    }

    const updateData: Record<string, unknown> = {
      doc_type: docType,
      markdown: finalMarkdown,
      embedding: serializeEmbeddingForDatabase(embedding),
      payload: finalPayload,
      modified_at: new Date(),
    };

    if (nomicEmbedding) {
      updateData.nomic_embedding = serializeEmbeddingForDatabase(nomicEmbedding);
    }

    const { error } = await this.supabase.from("documents").update(updateData).eq("id", issueData.id).in("doc_type", ISSUE_DOCUMENT_TYPES);

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

    this.context.logger.ok("Issue updated successfully with id: " + issueData.id, {
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
    const { data, error } = await this.supabase.from("documents").select("*").eq("id", issueNodeId).in("doc_type", ISSUE_DOCUMENT_TYPES).is("deleted_at", null);
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
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date().toISOString() })
      .eq("id", issueNodeId)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);
    if (error) {
      this.context.logger.error("Error deleting issue", { err: error });
      return;
    }
    this.context.logger.ok("Issue deleted successfully with id: " + issueNodeId);
  }

  async findSimilarIssues({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping issue similarity search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping issue similarity search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }

      const model = getEmbeddingModel(this.context);

      if (model === "nomic" && isNomicAvailable(this.context)) {
        const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource);
        const { data, error } = await this.supabase.rpc("find_similar_issues_annotate_nomic", {
          query_embedding: nomicEmbedding,
          current_id: currentId,
          threshold,
          top_k: 5,
        });
        if (error) {
          this.context.logger.error("Unable to find similar issues (Nomic)", {
            Error: error,
            markdown,
            currentId,
            threshold,
          });
          return null;
        }
        return data;
      } else {
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
      }
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
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping issue match search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_ISSUE_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping issue match search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_ISSUE_MARKDOWN_LENGTH,
        });
        return null;
      }

      const model = getEmbeddingModel(this.context);

      if (model === "nomic" && isNomicAvailable(this.context)) {
        const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource);
        const { data, error } = await this.supabase.rpc("find_similar_issues_to_match_nomic", {
          current_id: currentId,
          query_embedding: nomicEmbedding,
          threshold,
          top_k: topK ?? 5,
        });
        if (error) {
          this.context.logger.error("Error finding similar issues (Nomic)", {
            Error: error,
            markdown,
            threshold,
          });
          return null;
        }
        return data;
      } else {
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
      }
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
