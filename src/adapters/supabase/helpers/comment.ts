import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { COMMENT_DOCUMENT_TYPES, CommentDocumentType } from "../../../types/document";
import { serializeEmbeddingForDatabase } from "../../../utils/database-embedding";
import { cleanMarkdown, isTooShort, MIN_COMMENT_MARKDOWN_LENGTH } from "../../../utils/embedding-content";
import { isCommandLikeContent } from "../../../utils/markdown-comments";
import { PluginSettings } from "../../../types/plugin-input";

export interface CommentType {
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

function getEmbeddingModel(context: Context): "voyage" | "nomic" {
  const config = context.config as PluginSettings | undefined;
  return config?.embeddingModel ?? "voyage";
}

function isNomicAvailable(context: Context): boolean {
  return !!context.env.NOMIC_API_KEY;
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
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;

    // First Check if the comment already exists
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
    if (existingData && existingData.length > 0) {
      this.context.logger.warn("Comment already exists", {
        commentData: commentData,
      });
      return;
    }

    // Create embeddings for this comment
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
          this.context.logger.warn("Failed to create Nomic embedding for comment, continuing with Voyage only.", {
            Error: nomicError instanceof Error ? nomicError : new Error(String(nomicError)),
            commentId: commentData.id,
          });
        }
      }
    }

    let finalMarkdown = shouldSkipEmbedding ? null : commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const insertData: Record<string, unknown> = {
      id: commentData.id,
      doc_type: docType,
      parent_id: commentData.issue_id,
      markdown: finalMarkdown,
      author_id: commentData.author_id,
      embedding: serializeEmbeddingForDatabase(embedding),
      payload: finalPayload,
    };

    if (nomicEmbedding) {
      insertData.nomic_embedding = serializeEmbeddingForDatabase(nomicEmbedding);
    }

    const { data, error } = await this.supabase.from("documents").insert([insertData]);
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
    const shouldSkipEmbedding = isCommandComment || isShortComment;
    const embeddingSource = shouldSkipEmbedding ? null : cleanedMarkdown;

    // Create embeddings for this comment
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
          this.context.logger.warn("Failed to create Nomic embedding during comment update, continuing with Voyage only.", {
            Error: nomicError instanceof Error ? nomicError : new Error(String(nomicError)),
            commentId: commentData.id,
          });
        }
      }
    }

    let finalMarkdown = shouldSkipEmbedding ? null : commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
    }

    const comments = await this.getComment(commentData.id);
    if (comments && comments.length == 0) {
      this.context.logger.debug("Comment does not exist, creating a new one");
      await this.createComment({ ...commentData, markdown: finalMarkdown, payload: finalPayload, isPrivate }, { deferEmbedding: shouldDeferEmbedding });
    } else {
      const updateData: Record<string, unknown> = {
        doc_type: docType,
        parent_id: commentData.issue_id,
        markdown: finalMarkdown,
        embedding: serializeEmbeddingForDatabase(embedding),
        payload: finalPayload,
        modified_at: new Date(),
      };

      if (nomicEmbedding) {
        updateData.nomic_embedding = serializeEmbeddingForDatabase(nomicEmbedding);
      }

      const { error } = await this.supabase.from("documents").update(updateData).eq("id", commentData.id).in("doc_type", COMMENT_DOCUMENT_TYPES);
      if (error) {
        this.context.logger.error("Error updating comment", {
          Error: error,
          commentData: {
            commentData,
            markdown: finalMarkdown,
            embedding,
            payload: finalPayload,
            modified_at: new Date(),
          },
        });
        return;
      }
      this.context.logger.ok("Comment updated successfully with id: " + commentData.id, {
        commentData: {
          commentData,
          markdown: finalMarkdown,
          embedding,
          payload: finalPayload,
          modified_at: new Date(),
        },
      });
    }
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

      const model = getEmbeddingModel(this.context);

      if (model === "nomic" && isNomicAvailable(this.context)) {
        const nomicEmbedding = await this.context.adapters.nomic.embedding.createEmbedding(embeddingSource);
        const { data, error } = await this.supabase.rpc("find_similar_comments_nomic", {
          current_id: currentId,
          query_embedding: nomicEmbedding,
          threshold,
          top_k: 5,
        });
        if (error) {
          this.context.logger.error("Unable to find similar comments (Nomic)", {
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
      }
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
