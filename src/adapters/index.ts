import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { CronDatabaseClient, createCronDatabase } from "../cron/database-handler";
import { Context } from "../types/index";
import { LlmAdapter } from "./llm/index";
import { Comment } from "./supabase/helpers/comment";
import { Issue } from "./supabase/helpers/issues";
import { SuperSupabase } from "./supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "./voyage/helpers/embedding";
import { SuperVoyage } from "./voyage/helpers/voyage";
import { Embedding as NomicEmbedding } from "./nomic/helpers/embedding";
import { SuperNomic } from "./nomic/helpers/nomic";

export type EmbeddingModel = "voyage" | "nomic";

export type AdapterSet = {
  supabase: {
    comment: Comment;
    issue: Issue;
    super: SuperSupabase;
  };
  voyage: {
    embedding: VoyageEmbedding;
    super: SuperVoyage;
  };
  nomic: {
    embedding: NomicEmbedding;
    super: SuperNomic;
  };
  kv: CronDatabaseClient;
  llm: LlmAdapter;
};

export async function createAdapters(supabaseClient: SupabaseClient, voyage: VoyageAIClient, context: Context): Promise<AdapterSet> {
  return {
    supabase: {
      comment: new Comment(supabaseClient, context),
      issue: new Issue(supabaseClient, context),
      super: new SuperSupabase(supabaseClient, context),
    },
    voyage: {
      embedding: new VoyageEmbedding(voyage, context),
      super: new SuperVoyage(voyage, context),
    },
    nomic: {
      embedding: new NomicEmbedding(context),
      super: new SuperNomic(context),
    },
    kv: await createCronDatabase(),
    llm: new LlmAdapter(context),
  };
}

export function serializeEmbeddingForDatabase(embedding: number[] | null): string | null {
  return embedding ? JSON.stringify(embedding) : null;
}
