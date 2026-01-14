import { SupabaseClient } from "@supabase/supabase-js";
import { Context } from "../../../types/context";
import { COMMENT_DOCUMENT_TYPES, ISSUE_DOCUMENT_TYPES } from "../../../types/document";

export class SuperSupabase {
  protected supabase: SupabaseClient;
  protected context: Context;

  constructor(supabase: SupabaseClient, context: Context) {
    this.supabase = supabase;
    this.context = context;
  }

  async checkConnection(): Promise<boolean> {
    const { error } = await this.supabase.from("documents").select("*").limit(1);
    // If there's no error, the connection is working
    if (!error) {
      return true;
    } else {
      this.context.logger.error("Error connecting to Supabase or Schema has not been migrated/created");
      return false;
    }
  }

  async hasPendingEmbeddings(): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("documents")
      .select("id")
      .in("doc_type", [...ISSUE_DOCUMENT_TYPES, ...COMMENT_DOCUMENT_TYPES])
      .is("embedding", null)
      .is("deleted_at", null)
      .not("markdown", "is", null)
      .limit(1);

    if (error) {
      this.context.logger.error("Failed to check pending embeddings", { error });
      return false;
    }

    return Boolean(data && data.length > 0);
  }
}
