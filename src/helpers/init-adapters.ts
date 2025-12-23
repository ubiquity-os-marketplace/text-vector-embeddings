import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { createAdapters } from "../adapters/index";
import { Database } from "../types/database";
import { Context } from "../types/index";

export async function initAdapters(context: Context) {
  const { env } = context;

  const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_KEY);
  const voyageClient = new VoyageAIClient({
    apiKey: env.VOYAGEAI_API_KEY,
  });
  const adapters = await createAdapters(supabase, voyageClient, context);
  const isConnectionValid = await adapters.supabase.super.checkConnection();
  context.logger[isConnectionValid ? "ok" : "error"](`Supabase connection ${isConnectionValid ? "successful" : "failed"}`);

  return adapters;
}
