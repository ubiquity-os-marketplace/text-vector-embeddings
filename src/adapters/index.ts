import { SupabaseClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { Context } from "../types/index";
import { createPostgresIssueStore, IssueStore } from "./postgres-issue-store";
import { LlmAdapter } from "./llm/index";
import { Comment } from "./supabase/helpers/comment";
import { Issue } from "./supabase/helpers/issues";
import { SuperSupabase } from "./supabase/helpers/supabase";
import { Embedding as VoyageEmbedding } from "./voyage/helpers/embedding";
import { SuperVoyage } from "./voyage/helpers/voyage";
import { Embedding as NomicEmbedding } from "./nomic/helpers/embedding";
import { SuperNomic } from "./nomic/helpers/nomic";

type AdapterSet = {
  supabase: {
    comment: Comment;
    issue: Issue;
    super: SuperSupabase;
  };
  nomic?: {
    embedding: NomicEmbedding;
    super: SuperNomic;
  };
  nomic: context.env.NOMIC_API_KEY ? {
      embedding: new NomicEmbedding(context.env.NOMIC_API_KEY, context),
      super: new SuperNomic(context.env.NOMIC_API_KEY, context),
    } : undefined,
    voyage: {
    embedding: VoyageEmbedding;
    super: SuperVoyage;
  };
  issueStore: IssueStore;
  llm: LlmAdapter;
  close(): Promise<void>;
};

export async function createAdapters(supabaseClient: SupabaseClient, voyage: VoyageAIClient, context: Context): Promise<AdapterSet> {
  const issueStore = await createPostgresIssueStore(context.env.DATABASE_URL);

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
    issueStore,
    llm: new LlmAdapter(context),
    close: async () => {
      await issueStore.close();
    },
  };
}
