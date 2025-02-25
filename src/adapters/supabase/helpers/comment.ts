import { SupabaseClient } from "@supabase/supabase-js";
import { SuperSupabase } from "./supabase";
import { Context } from "../../../types/context";
import { markdownToPlainText } from "../../utils/markdown-to-plaintext";

export interface CommentType {
  id: string;
  markdown?: string;
  author_id: number;
  created_at: string;
  modified_at: string;
  embedding: number[];
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
    //Create the embedding for this comment
    const embedding = await this.context.adapters.voyage.embedding.createEmbedding(commentData.markdown);
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
        payload: finalPayload,
        issue_id: commentData.issue_id,
        plaintext,
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
  }

  async updateComment(commentData: CommentData) {
    const { isPrivate } = commentData;
    //Create the embedding for this comment
    const embedding = Array.from(await this.context.adapters.voyage.embedding.createEmbedding(commentData.markdown));
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
        .update({ markdown: finalMarkdown, plaintext, embedding: embedding, payload: finalPayload, modified_at: new Date() })
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
          modified_at: new Date(),
        },
      });
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
    const { error } = await this.supabase.from("issue_comments").delete().eq("id", commentNodeId);
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

  async findSimilarComments({ markdown, currentId, threshold }: FindSimilarCommentsParams): Promise<CommentSimilaritySearchResult[] | null> {
    // Create a new issue embedding
    try {
      const embedding = await this.context.adapters.voyage.embedding.createEmbedding(markdown);
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
