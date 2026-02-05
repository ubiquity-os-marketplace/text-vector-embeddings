import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { COMMENT_DOCUMENT_TYPES, CommentDocumentType } from "../../../types/document";
import { cleanMarkdown, isTooShort, MIN_COMMENT_MARKDOWN_LENGTH } from "../../../utils/embedding-content";
import { isCommandLikeContent } from "../../../utils/markdown-comments";
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

function getNestedNumber(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[key];
  }
  return typeof current === "number" ? current : null;
}

function getAuthorType(payload: Record<string, unknown> | null, docType: CommentDocumentType): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (docType === "pull_request_review") {
    return getNestedString(payload, ["review", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
  }
  return getNestedString(payload, ["comment", "user", "type"]) ?? getNestedString(payload, ["sender", "type"]);
}

function isReviewCommentThreadRoot(payload: Record<string, unknown> | null): boolean {
  const parentId = getNestedNumber(payload, ["comment", "in_reply_to_id"]);
  return parentId === null;
}

export interface CommentType {
  id: string;
  doc_type?: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[] | null;
  deleted_at?: string | null;
}

export interface CommentData {
  markdown: string | null;
  id: string;
  author_id: number;
  payload: Record<string, unknown> | null;
  isPrivate: boolean;
  issue_id: string | null;
  docType?: CommentDocumentType;
}

export interface CommentWriteOptions {
  deferEmbedding?: boolean;
}

export interface CommentSimilaritySearchResult {
  comment_id: string;
  similarity: number;
}

interface FindSimilarCommentsParams {
  markdown: string;
  currentId: string;
  threshold: number;
}

export class Comment extends SuperSupabase {
  constructor(supabase: SupabaseClient, context: Context) {
    super(supabase, context);
  }

  async createComment(commentData: CommentData, options: CommentWriteOptions = {}) {
    const { isPrivate } = commentData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = commentData.docType ?? "issue_comment";
    const cleanedMarkdown = cleanMarkdown(commentData.markdown);
    const isCommandComment = cleanedMarkdown ? isCommandLikeContent(cleanedMarkdown) : false;
    const isShortComment = isTooShort(cleanedMarkdown, MIN_COMMENT_MARKDOWN_LENGTH);
    const authorType = getAuthorType(commentData.payload, docType);
    const isBotRootReviewAllowed = docType === "review_comment" && isReviewCommentThreadRoot(commentData.payload);
    const isNonUserAuthor = Boolean(authorType) && authorType !== "User" && !isBotRootReviewAllowed;
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;
    //First Check if the comment already exists
    const { data: existingData, error: existingError } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", commentData.id)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error creating comment", {
        Error: existingError,
        commentData,
      });
      return;
    }
    const existing = existingData && existingData.length > 0 ? existingData[0] : null;
    const shouldStore = !isPrivate && !shouldSkipEmbedding && !isNonUserAuthor;
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
          .eq("id", commentData.id)
          .in("doc_type", COMMENT_DOCUMENT_TYPES);
        if (deleteError) {
          this.context.logger.error("Failed to soft-delete skipped comment", { Error: deleteError, commentData });
        }
      }
      this.context.logger.debug("Skipping comment storage for non-embeddable content.", {
        id: commentData.id,
        docType,
        isPrivate,
        isNonUserAuthor,
        isCommandComment,
        isShortComment,
      });
      return;
    }

    const shouldEmbed = Boolean(embeddingSource) && !isPrivate;
    //Create the embedding for this comment
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
    const payload = isPrivate ? null : commentData.payload;
    if (existing) {
      const { error } = await this.supabase
        .from("documents")
        .update({
          doc_type: docType,
          parent_id: commentData.issue_id,
          markdown: commentData.markdown,
          author_id: commentData.author_id,
          embedding,
          embedding_status: embeddingStatus,
          embedding_model: embeddingModel,
          embedding_dim: embeddingDim,
          payload,
          deleted_at: null,
          modified_at: new Date().toISOString(),
        })
        .eq("id", commentData.id)
        .in("doc_type", COMMENT_DOCUMENT_TYPES);
      if (error) {
        this.context.logger.error("Failed to update comment in database", {
          Error: error,
          commentData,
        });
        return;
      }
      this.context.logger.ok(`Comment updated successfully with id: ${commentData.id}`, { data: existing });
      return;
    }

    const { data, error } = await this.supabase.from("documents").insert([
      {
        id: commentData.id,
        doc_type: docType,
        parent_id: commentData.issue_id,
        markdown: commentData.markdown,
        author_id: commentData.author_id,
        embedding,
        embedding_status: embeddingStatus,
        embedding_model: embeddingModel,
        embedding_dim: embeddingDim,
        payload,
      },
    ]);
    if (error) {
      this.context.logger.error("Failed to create comment in database", {
        Error: error,
        commentData,
      });
      return;
    }
    this.context.logger.ok(`Comment created successfully with id: ${commentData.id}`, { data });
  }

  async updateComment(commentData: CommentData, options: CommentWriteOptions = {}) {
    const { isPrivate } = commentData;
    const { deferEmbedding: shouldDeferEmbedding = false } = options;
    const docType = commentData.docType ?? "issue_comment";
    const cleanedMarkdown = cleanMarkdown(commentData.markdown);
    const isCommandComment = cleanedMarkdown ? isCommandLikeContent(cleanedMarkdown) : false;
    const isShortComment = isTooShort(cleanedMarkdown, MIN_COMMENT_MARKDOWN_LENGTH);
    const authorType = getAuthorType(commentData.payload, docType);
    const isBotRootReviewAllowed = docType === "review_comment" && isReviewCommentThreadRoot(commentData.payload);
    const isNonUserAuthor = Boolean(authorType) && authorType !== "User" && !isBotRootReviewAllowed;
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;
    const shouldEmbed = Boolean(embeddingSource) && !isPrivate;
    //Create the embedding for this comment
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
      .eq("id", commentData.id)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (existingError) {
      this.context.logger.error("Error loading comment for update", { Error: existingError, commentData });
      return;
    }
    const existing = existingData && existingData.length > 0 ? existingData[0] : null;
    const shouldStore = !isPrivate && !shouldSkipEmbedding && !isNonUserAuthor;
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
          .eq("id", commentData.id)
          .in("doc_type", COMMENT_DOCUMENT_TYPES);
        if (error) {
          this.context.logger.error("Error soft-deleting comment", { Error: error, commentData });
        }
      }
      this.context.logger.debug("Skipping comment update for non-embeddable content.", {
        id: commentData.id,
        docType,
        isPrivate,
        isNonUserAuthor,
        isCommandComment,
        isShortComment,
      });
      return;
    }

    const payload = isPrivate ? null : commentData.payload;
    if (!existing) {
      await this.createComment({ ...commentData, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
      return;
    }

    const { error } = await this.supabase
      .from("documents")
      .update({
        doc_type: docType,
        parent_id: commentData.issue_id,
        markdown: commentData.markdown,
        embedding,
        embedding_status: embeddingStatus,
        embedding_model: embeddingModel,
        embedding_dim: embeddingDim,
        payload,
        deleted_at: null,
        modified_at: now,
      })
      .eq("id", commentData.id)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (error) {
      this.context.logger.error("Error updating comment", {
        Error: error,
        commentData: {
          commentData,
          markdown: commentData.markdown,
          embedding,
          payload,
          modified_at: now,
        },
      });
      return;
    }
    this.context.logger.ok("Comment updated successfully with id: " + commentData.id, {
      commentData: {
        commentData,
        markdown: commentData.markdown,
        embedding,
        payload,
        modified_at: now,
      },
    });
  }

  async getComment(commentNodeId: string): Promise<CommentType[] | null> {
    const { data, error } = await this.supabase
      .from("documents")
      .select("*")
      .eq("id", commentNodeId)
      .in("doc_type", COMMENT_DOCUMENT_TYPES)
      .is("deleted_at", null);
    if (error) {
      this.context.logger.error("Error getting comment", {
        Error: error,
        commentData: {
          id: commentNodeId,
        },
      });
      return null;
    }
    return data;
  }

  async deleteComment(commentNodeId: string) {
    const { error } = await this.supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date().toISOString() })
      .eq("id", commentNodeId)
      .in("doc_type", COMMENT_DOCUMENT_TYPES);
    if (error) {
      this.context.logger.error("Error deleting comment", {
        Error: error,
        commentData: {
          id: commentNodeId,
        },
      });
      return;
    }
    this.context.logger.ok("Comment deleted successfully with id: " + commentNodeId);
  }

  async findSimilarComments({ markdown, currentId, threshold }: FindSimilarCommentsParams): Promise<CommentSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = cleanMarkdown(markdown);
      if (!embeddingSource) {
        this.context.logger.debug("Skipping comment similarity search because text is empty after stripping comments.", { currentId });
        return null;
      }
      if (isTooShort(embeddingSource, MIN_COMMENT_MARKDOWN_LENGTH)) {
        this.context.logger.debug("Skipping comment similarity search because text is too short.", {
          currentId,
          length: embeddingSource.length,
          minLength: MIN_COMMENT_MARKDOWN_LENGTH,
        });
        return null;
      }
      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
      const { data, error } = await this.supabase.rpc("find_similar_comments_annotate", {
        query_embedding: embedding,
        current_id: currentId,
        threshold,
        top_k: 5,
      });
      if (error) {
        this.context.logger.error("Unable to find similar comments", {
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
      this.context.logger.error("Unable to find similar comments", {
        Error: error,
        markdown,
        currentId,
        threshold,
      });
      return null;
    }
  }
}
