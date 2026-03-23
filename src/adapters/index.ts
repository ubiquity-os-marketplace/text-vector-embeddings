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

type AdapterSet = {
  supabase: {
    comment: Comment;
    issue: Issue;
    super: SuperSupabase;
  };
  voyage: {
    embedding: VoyageEmbedding;
    super: SuperVoyage;
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
    kv: await createCronDatabase(),
    llm: new LlmAdapter(context),
  };
}
