import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * Define sensitive environment variables here.
 *
 * These are fed into the worker/workflow as `env` and are
 * taken from either `dev.vars` or repository secrets.
 * They are used with `process.env` but are type-safe.
 */
export const envSchema = T.Object({
  SUPABASE_URL: T.String(),
  SUPABASE_KEY: T.String(),
  VOYAGEAI_API_KEY: T.String(),
  DENO_KV_URL: T.Optional(T.String()),
  LOG_LEVEL: T.Optional(T.String()),
  KERNEL_PUBLIC_KEY: T.Optional(T.String()),
  APP_ID: T.Optional(T.String()),
  APP_PRIVATE_KEY: T.Optional(T.String()),
});

export type Env = StaticDecode<typeof envSchema>;
