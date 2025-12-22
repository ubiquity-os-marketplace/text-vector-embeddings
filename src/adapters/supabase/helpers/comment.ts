import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { markdownToPlainText } from "../../utils/markdown-to-plaintext";
import { stripHtmlComments } from "../../../utils/markdown-comments";
import { VOYAGE_EMBEDDING_MODEL } from "../../voyage/helpers/embedding";
import { enqueueEmbeddingJob, processEmbeddingQueue, shouldDeferEmbedding } from "../../../helpers/embedding-queue";

export interface CommentType {
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

export interface CommentData {
  markdown: string | null;
  id: string;
  author_id: number;
  payload: Record<string, unknown> | null;
  isPrivate: boolean;
  issue_id: string;
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

  async createComment(commentData: CommentData) {
    const { isPrivate } = commentData;
    //First Check if the comment already exists
    const { data: existingData, error: existingError } = await this.supabase.from("issue_comments").select("*").eq("id", commentData.id);
    if (existingError) {
      this.context.logger.error("Error creating comment", {
        Error: existingError,
        commentData,
      });
      return;
    }
    if (existingData && existingData.length > 0) {
      this.context.logger.error("Comment already exists", {
        commentData: commentData,
      });
      return;
    }
    const shouldDefer = shouldDeferEmbedding(this.context, isPrivate);
    const embeddingSource = commentData.markdown ? stripHtmlComments(commentData.markdown) : commentData.markdown;
    const embedding = shouldDefer ? null : await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource);
    let plaintext: string | null = markdownToPlainText(commentData.markdown);
    let finalMarkdown = commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
      plaintext = null;
    }
    const { data, error } = await this.supabase.from("issue_comments").insert([
      {
        id: commentData.id,
        markdown: finalMarkdown,
        author_id: commentData.author_id,
        embedding,
        embedding_status: embedding ? "ready" : "pending",
        embedding_model: embedding ? VOYAGE_EMBEDDING_MODEL : null,
        embedding_dim: embedding ? embedding.length : null,
        payload: finalPayload,
        issue_id: commentData.issue_id,
        plaintext,
        deleted_at: null,
      },
    ]);
    if (error) {
      this.context.logger.error("Failed to create comment in database", {
        Error: error,
        commentData,
      });
      return;
    }
    this.context.logger.info(`Comment created successfully with id: ${commentData.id}`, { data });
    if (shouldDefer) {
      await enqueueEmbeddingJob(this.context, { table: "issue_comments", id: commentData.id });
      await processEmbeddingQueue(this.context);
    }
  }

  async updateComment(commentData: CommentData) {
    const { isPrivate } = commentData;
    const shouldDefer = shouldDeferEmbedding(this.context, isPrivate);
    const embeddingSource = commentData.markdown ? stripHtmlComments(commentData.markdown) : commentData.markdown;
    const embedding = shouldDefer ? null : Array.from(await this.context.adapters.voyage.embedding.createEmbedding(embeddingSource));
    let plaintext: string | null = markdownToPlainText(commentData.markdown);
    let finalMarkdown = commentData.markdown;
    let finalPayload = commentData.payload;

    if (isPrivate) {
      finalMarkdown = null;
      finalPayload = null;
      plaintext = null;
    }
    const comments = await this.getComment(commentData.id);
    if (comments && comments.length == 0) {
      this.context.logger.info("Comment does not exist, creating a new one");
      await this.createComment({ ...commentData, markdown: finalMarkdown, payload: finalPayload, isPrivate });
    } else {
      const { error } = await this.supabase
        .from("issue_comments")
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
        .eq("id", commentData.id);
      if (error) {
        this.context.logger.error("Error updating comment", {
          Error: error,
          commentData: {
            commentData,
            markdown: finalMarkdown,
            plaintext,
            embedding,
            payload: finalPayload,
            embedding_status: embedding ? "ready" : "pending",
            modified_at: new Date(),
          },
        });
        return;
      }
      this.context.logger.info("Comment updated successfully with id: " + commentData.id, {
        commentData: {
          commentData,
          markdown: finalMarkdown,
          plaintext,
          embedding,
          payload: finalPayload,
          embedding_status: embedding ? "ready" : "pending",
          modified_at: new Date(),
        },
      });
    }
    if (shouldDefer) {
      await enqueueEmbeddingJob(this.context, { table: "issue_comments", id: commentData.id });
      await processEmbeddingQueue(this.context);
    }
  }

  async getComment(commentNodeId: string): Promise<CommentType[] | null> {
    const { data, error } = await this.supabase.from("issue_comments").select("*").eq("id", commentNodeId);
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
      .from("issue_comments")
      .update({ deleted_at: new Date().toISOString(), modified_at: new Date() })
      .eq("id", commentNodeId);
    if (error) {
      this.context.logger.error("Error deleting comment", {
        Error: error,
        commentData: {
          id: commentNodeId,
        },
      });
      return;
    }
    this.context.logger.info("Comment deleted successfully with id: " + commentNodeId);
  }

  async updateEmbedding(commentNodeId: string, embedding: number[], model: string) {
    const { error } = await this.supabase
      .from("issue_comments")
      .update({
        embedding,
        embedding_status: "ready",
        embedding_model: model,
        embedding_dim: embedding.length,
        modified_at: new Date(),
      })
      .eq("id", commentNodeId);
    if (error) {
      this.context.logger.error("Error updating comment embedding", { Error: error, commentId: commentNodeId });
    }
  }

  async markEmbeddingFailed(commentNodeId: string) {
    const { error } = await this.supabase.from("issue_comments").update({ embedding_status: "failed", modified_at: new Date() }).eq("id", commentNodeId);
    if (error) {
      this.context.logger.error("Error marking comment embedding failed", { Error: error, commentId: commentNodeId });
    }
  }

  async findSimilarComments({ markdown, currentId, threshold }: FindSimilarCommentsParams): Promise<CommentSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embeddingSource = stripHtmlComments(markdown);
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
