import { createClient, SupabaseClient } from "@supabase/supabase-js";

type TableSpec = {
  name: string;
  orderBy: string;
};

const TABLES: TableSpec[] = [
  { name: "issues", orderBy: "id" },
  { name: "issue_comments", orderBy: "id" },
];

function getEnv(name: string, fallbackName?: string): string {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    const fallbackHint = fallbackName ? ` (or ${fallbackName})` : "";
    console.error(`Missing required env var: ${name}${fallbackHint}`);
    process.exit(1);
  }
  return value;
}

function parseBatchSize(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "100", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid BATCH_SIZE: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

const sourceUrl = getEnv("SUPABASE_SOURCE_URL", "SUPABASE_URL");
const sourceKey = getEnv("SUPABASE_SOURCE_KEY", "SUPABASE_KEY");
const targetUrl = getEnv("SUPABASE_TARGET_URL");
const targetKey = getEnv("SUPABASE_TARGET_KEY");

const batchSize = parseBatchSize(process.env.BATCH_SIZE);
const isDryRun = (process.env.DRY_RUN ?? "").toLowerCase() === "true";

const source = createClient(sourceUrl, sourceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const target = createClient(targetUrl, targetKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function fetchCount(client: SupabaseClient, table: string): Promise<number | null> {
  const { count, error } = await client.from(table).select("id", { count: "exact", head: true });
  if (error) {
    console.error(`Failed to count ${table}:`, error.message);
    return null;
  }
  return count ?? null;
}

async function copyTable({ name, orderBy }: TableSpec): Promise<void> {
  console.log(`\nStarting ${name} migration...`);

  const sourceCount = await fetchCount(source, name);
  const targetCountBefore = await fetchCount(target, name);

  let offset = 0;
  while (true) {
    const { data, error } = await source
      .from(name)
      .select("*")
      .order(orderBy, { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      throw new Error(`Failed to read ${name} at offset ${offset}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    if (isDryRun) {
      console.log(`[dry-run] Would upsert ${data.length} row(s) into ${name}.`);
    } else {
      const { error: upsertError } = await target.from(name).upsert(data, { onConflict: "id" });
      if (upsertError) {
        throw new Error(`Failed to upsert ${name} at offset ${offset}: ${upsertError.message}`);
      }
    }

    offset += data.length;
    const progress = sourceCount ? `${offset}/${sourceCount}` : `${offset}`;
    console.log(`Progress ${name}: ${progress}`);

    if (data.length < batchSize) {
      break;
    }
  }

  const targetCountAfter = await fetchCount(target, name);

  console.log(
    `Finished ${name}. Source=${sourceCount ?? "unknown"} TargetBefore=${targetCountBefore ?? "unknown"} TargetAfter=${targetCountAfter ?? "unknown"}`
  );

  if (!isDryRun && sourceCount !== null && targetCountAfter !== null && targetCountAfter < sourceCount) {
    throw new Error(`Row count mismatch for ${name}: source=${sourceCount} target=${targetCountAfter}`);
  }
}

async function main(): Promise<void> {
  console.log(`Batch size: ${batchSize}`);
  console.log(`Dry run: ${isDryRun}`);

  for (const table of TABLES) {
    await copyTable(table);
  }

  console.log("\nMigration complete.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
