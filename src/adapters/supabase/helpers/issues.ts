import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { IssueDocumentType, ISSUE_DOCUMENT_TYPES } from "../../../types/document";
import { cleanMarkdown, isTooShort, MIN_ISSUE_MARKDOWN_LENGTH } from "../../../utils/embedding-content";
import { VOYAGE_EMBEDDING_DIM, VOYAGE_EMBEDDING_MODEL } from "../../voyage/helpers/embedding";

type JsonRecord = Record<string, unknown>;

function getNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "string" ? current : null;
}

function getAuthorType(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return (
    getNestedString(payload, ["issue", "user", "type"]) ??
    getNestedString(payload, ["pull_request", "user", "type"]) ??
    getNestedString(payload, ["sender", "type"])
  );
}

export interface IssueType {
  id: string;
  doc_type?: string;
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
    const authorType = getAuthorType(issueData.payload);
    const isNonUserAuthor = Boolean(authorType) && authorType !== "User";
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;
    //First Check if the issue already exists
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
    const existing = existingData && existingData.length > 0 ? existingData[0] : null;
    const shouldStore = !isPrivate && !isShortIssue && !isNonUserAuthor;
    if (!shouldStore) {
      if (existing) {
        const now = new Date().toISOString();
        const { error: deleteError } = await this.supabase
          .from("documents")
          .update({
            markdown: null,
            embedding: null,
            embedding_status: "ready",
            embedding_model: null,
            embedding_dim: null,
            deleted_at: now,
            modified_at: now,
          })
          .eq("id", issueData.id)
          .in("doc_type", ISSUE_DOCUMENT_TYPES);
        if (deleteError) {
          this.context.logger.error("Failed to soft-delete skipped issue", { Error: deleteError, issueData });
        }
      }
      this.context.logger.debug("Skipping issue storage for non-embeddable content.", {
        id: issueData.id,
        docType,
        isPrivate,
        isNonUserAuthor,
        isShortIssue,
      });
      return;
    }

    const shouldEmbed = Boolean(embeddingSource) && !isPrivate;
    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && shouldEmbed) {
      embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    }
    const hasEmbedding = Boolean(embedding && embedding.length > 0);
    let embeddingStatus = "ready";
    if (!hasEmbedding && shouldDeferEmbedding && shouldEmbed) {
      embeddingStatus = "pending";
    }
    const embeddingModel = hasEmbedding ? VOYAGE_EMBEDDING_MODEL : null;
    const embeddingDim = hasEmbedding ? VOYAGE_EMBEDDING_DIM : null;
    const payload = isPrivate ? null : issueData.payload;
    if (existing) {
      const { error } = await this.supabase
        .from("documents")
        .update({
          doc_type: docType,
          parent_id: null,
          embedding,
          embedding_status: embeddingStatus,
          embedding_model: embeddingModel,
          embedding_dim: embeddingDim,
          payload,
          author_id: issueData.author_id,
          markdown: issueData.markdown,
          deleted_at: null,
          modified_at: new Date().toISOString(),
        })
        .eq("id", issueData.id)
        .in("doc_type", ISSUE_DOCUMENT_TYPES);
      if (error) {
        this.context.logger.error("Failed to update issue in database", {
          Error: error,
          issueData,
        });
        return;
      }
      this.context.logger.ok(`Issue updated successfully with id: ${issueData.id}`, { data: existing });
      return;
    }

    const { data, error } = await this.supabase.from("documents").insert([
      {
        id: issueData.id,
        doc_type: docType,
        parent_id: null,
        embedding,
        embedding_status: embeddingStatus,
        embedding_model: embeddingModel,
        embedding_dim: embeddingDim,
        payload,
        author_id: issueData.author_id,
        markdown: issueData.markdown,
      },
    ]);
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
    const authorType = getAuthorType(issueData.payload);
    const isNonUserAuthor = Boolean(authorType) && authorType !== "User";
    const embeddingSource = !isShortIssue ? cleanedMarkdown : null;
    const shouldEmbed = Boolean(embeddingSource) && !isPrivate;
    //Create the embedding for this issue
    let embedding: number[] | null = null;
    if (!shouldDeferEmbedding && shouldEmbed) {
      embedding = Array.from(await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource));
    }
    const hasEmbedding = Boolean(embedding && embedding.length > 0);
    let embeddingStatus = "ready";
    if (!hasEmbedding && shouldDeferEmbedding && shouldEmbed) {
      embeddingStatus = "pending";
    }
    const embeddingModel = hasEmbedding ? VOYAGE_EMBEDDING_MODEL : null;
    const embeddingDim = hasEmbedding ? VOYAGE_EMBEDDING_DIM : null;
    const { data: existingData, error: existingError } = await this.supabase
      .from("documents")
      .select("id, deleted_at")
      .eq("id", issueData.id)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error loading issue for update", { Error: existingError, issueData });
      return;
    }
    const existing = existingData && existingData.length > 0 ? existingData[0] : null;
    const shouldStore = !isPrivate && !isShortIssue && !isNonUserAuthor;
    const now = new Date().toISOString();

    if (!shouldStore) {
      if (existing) {
        const { error } = await this.supabase
          .from("documents")
          .update({
            markdown: null,
            embedding: null,
            embedding_status: "ready",
            embedding_model: null,
            embedding_dim: null,
            deleted_at: now,
            modified_at: now,
          })
          .eq("id", issueData.id)
          .in("doc_type", ISSUE_DOCUMENT_TYPES);
        if (error) {
          this.context.logger.error("Error soft-deleting issue", { Error: error, issueData });
        }
      }
      this.context.logger.debug("Skipping issue update for non-embeddable content.", {
        id: issueData.id,
        docType,
        isPrivate,
        isNonUserAuthor,
        isShortIssue,
      });
      return;
    }

    const payload = isPrivate ? null : issueData.payload;
    if (!existing) {
      await this.createIssue({ ...issueData, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
      return;
    }

    const { error } = await this.supabase
      .from("documents")
      .update({
        doc_type: docType,
        markdown: issueData.markdown,
        embedding,
        embedding_status: embeddingStatus,
        embedding_model: embeddingModel,
        embedding_dim: embeddingDim,
        payload,
        deleted_at: null,
        modified_at: now,
      })
      .eq("id", issueData.id)
      .in("doc_type", ISSUE_DOCUMENT_TYPES);

    if (error) {
      this.context.logger.error("Error updating issue", {
        Error: error,
        issueData: {
          id: issueData.id,
          markdown: issueData.markdown,
          embedding,
          payload,
          modified_at: now,
        },
      });
      return;
    }

    this.context.logger.ok("Issue updated successfully with id: " + issueData.id, {
      issueData: {
        id: issueData.id,
        markdown: issueData.markdown,
        embedding,
        payload,
        modified_at: now,
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
    // Create a new issue embedding
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
