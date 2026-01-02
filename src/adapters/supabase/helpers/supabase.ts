import { SupabaseClient } from "@supabase/supabase-js";
import { Context } from "../../../types/context";

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
}
