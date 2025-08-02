import { SupabaseClient } from "@supabase/supabase-js";
import { createCronDatabase } from "../cron/database-handler";
import { Context } from "../types/index";
import { Comment } from "./supabase/helpers/comment";
import { SuperSupabase } from "./supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "./voyage/helpers/embedding";
import { SuperVoyage } from "./voyage/helpers/voyage";
import { VoyageAIClient } from "voyageai";
import { Issue } from "./supabase/helpers/issues";

export async function createAdapters(supabaseClient: SupabaseClient, voyage: VoyageAIClient, context: Context) {
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
  };
}
