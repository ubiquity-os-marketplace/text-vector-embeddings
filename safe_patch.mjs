import fs from 'fs';

// 1. Migration
const migration = `-- Add Nomic embedding column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_nomic vector(768);

CREATE INDEX IF NOT EXISTS documents_embedding_nomic_ivfflat
  ON public.documents USING ivfflat (embedding_nomic vector_cosine_ops)
  WITH (lists='10');

-- Duplicate RPCs for Nomic
CREATE OR REPLACE FUNCTION find_similar_issues_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_repo TEXT;
    current_org TEXT;
BEGIN
    SELECT
        payload->'repository'->>'name'::text,
        payload->'repository'->'owner'->>'login'::text
    INTO current_repo, current_org
    FROM documents
    WHERE id = current_id
      AND doc_type = 'issue';

    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
            AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
            AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_nomic(query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
            AND doc_type IN ('issue_comment', 'review_comment', 'pull_request_review')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.2 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;
`;
fs.writeFileSync('supabase/migrations/20251224000000_nomic_support.sql', migration);

// 2. Types
let envTs = fs.readFileSync('src/types/env.ts', 'utf8');
if (!envTs.includes('NOMIC_API_KEY')) {
    envTs = envTs.replace('VOYAGEAI_API_KEY: T.String(),', 'VOYAGEAI_API_KEY: T.Optional(T.String()),\n  NOMIC_API_KEY: T.Optional(T.String()),\n  EMBEDDING_MODEL: T.Optional(T.String({ default: "voyage-4-large" })),');
    fs.writeFileSync('src/types/env.ts', envTs);
}

let dbTs = fs.readFileSync('src/types/database.ts', 'utf8');
if (!dbTs.includes('embedding_nomic:')) {
    dbTs = dbTs.replace(/embedding\?: string \| null;/g, 'embedding?: string | null;\n          embedding_nomic?: string | null;');
    dbTs = dbTs.replace(/embedding: string \| null;/g, 'embedding: string | null;\n          embedding_nomic: string | null;');
    fs.writeFileSync('src/types/database.ts', dbTs);
}

// 3. Nomic Adapter
fs.mkdirSync('src/adapters/nomic/helpers', { recursive: true });
fs.writeFileSync('src/adapters/nomic/helpers/nomic.ts', `import { Context } from "../../../types/context";
export class SuperNomic {
  protected apiKey: string;
  protected context: Context;
  constructor(apiKey: string, context: Context) {
    this.apiKey = apiKey;
    this.context = context;
  }
}
`);
fs.writeFileSync('src/adapters/nomic/helpers/embedding.ts', `import { Context } from "../../../types/index";
import { SuperNomic } from "./nomic";

export class Embedding extends SuperNomic {
  constructor(apiKey: string, context: Context) {
    super(apiKey, context);
  }

  async createEmbedding(text: string | null): Promise<number[]> {
    if (!text) throw new Error("Text is null");
    const truncated = text.length > 24000 ? text.slice(0, 24000) : text;
    
    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": \`Bearer \${this.apiKey}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: [truncated], task_type: "search_document" })
    });
    
    if (!response.ok) {
      this.context.logger.error(\`Nomic API Error: \${response.statusText}\`);
      return [];
    }
    const data = await (response.json() as Promise<any>);
    return data.embeddings?.[0] ?? [];
  }

  async createEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const truncatedTexts = texts.map(t => t.length > 24000 ? t.slice(0, 24000) : t);
    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": \`Bearer \${this.apiKey}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: truncatedTexts, task_type: "search_document" })
    });
    
    if (!response.ok) {
      this.context.logger.error(\`Nomic API Error: \${response.statusText}\`);
      return [];
    }
    const data = await (response.json() as Promise<any>);
    return data.embeddings ?? [];
  }
}
`);

// 4. Index
let idxTs = fs.readFileSync('src/adapters/index.ts', 'utf8');
if (!idxTs.includes('NomicEmbedding')) {
    idxTs = idxTs.replace('import { SuperVoyage }', 'import { SuperVoyage } from "./voyage/helpers/voyage";\nimport { Embedding as NomicEmbedding } from "./nomic/helpers/embedding";\nimport { SuperNomic } from "./nomic/helpers/nomic";\n//');
    idxTs = idxTs.replace('voyage: {', 'nomic?: {\n    embedding: NomicEmbedding;\n    super: SuperNomic;\n  };\n  voyage?: {\n');
    idxTs = idxTs.replace('voyage: {', 'nomic: context.env.NOMIC_API_KEY ? {\n      embedding: new NomicEmbedding(context.env.NOMIC_API_KEY, context),\n      super: new SuperNomic(context.env.NOMIC_API_KEY, context),\n    } : undefined,\n    voyage: context.env.VOYAGEAI_API_KEY ? {\n');
    idxTs = idxTs.replace('embedding: new VoyageEmbedding(voyage, context),', 'embedding: new VoyageEmbedding(voyage!, context),');
    idxTs = idxTs.replace('super: new SuperVoyage(voyage, context),', 'super: new SuperVoyage(voyage!, context),');
    idxTs = idxTs.replace('    },', '    } : undefined,');
    fs.writeFileSync('src/adapters/index.ts', idxTs);
}

// 5. Plugin.ts
let pluginTs = fs.readFileSync('src/plugin.ts', 'utf8');
if (!pluginTs.includes('voyageClient = env.VOYAGEAI_API_KEY')) {
    pluginTs = pluginTs.replace(
        'const voyageClient = new VoyageAIClient({\n    apiKey: env.VOYAGEAI_API_KEY,\n  });',
        'const voyageClient = env.VOYAGEAI_API_KEY ? new VoyageAIClient({ apiKey: env.VOYAGEAI_API_KEY }) : null;'
    );
    pluginTs = pluginTs.replace('createAdapters(supabase, voyageClient, context)', 'createAdapters(supabase, voyageClient as any, context)');
    fs.writeFileSync('src/plugin.ts', pluginTs);
}

// 6. Comments
let commTs = fs.readFileSync('src/adapters/supabase/helpers/comment.ts', 'utf8');
commTs = commTs.replace(/embedding: serializeEmbeddingForDatabase\(embedding\),/g, 'embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding),\n          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding) : null,\n          embedding_model: embedding?.length === 768 ? "nomic-embed-text-v1.5" : "voyage-4-large",\n          embedding_dim: embedding?.length ?? null,');
commTs = commTs.replace(/this\.context\.adapters\.voyage\.embedding/g, '(this.context.adapters.nomic?.embedding ?? this.context.adapters.voyage?.embedding!)');
commTs = commTs.replace(/this\.supabase\.rpc\("([^"]+)",/g, 'this.supabase.rpc(("$1" + (embedding.length === 768 ? "_nomic" : "")) as any,');
fs.writeFileSync('src/adapters/supabase/helpers/comment.ts', commTs);

// 7. Issues
let issTs = fs.readFileSync('src/adapters/supabase/helpers/issues.ts', 'utf8');
issTs = issTs.replace(/embedding: serializeEmbeddingForDatabase\(embedding\),/g, 'embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding),\n          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding) : null,\n          embedding_model: embedding?.length === 768 ? "nomic-embed-text-v1.5" : "voyage-4-large",\n          embedding_dim: embedding?.length ?? null,');
issTs = issTs.replace(/this\.context\.adapters\.voyage\.embedding/g, '(this.context.adapters.nomic?.embedding ?? this.context.adapters.voyage?.embedding!)');
issTs = issTs.replace(/this\.supabase\.rpc\("([^"]+)",/g, 'this.supabase.rpc(("$1" + (embedding.length === 768 ? "_nomic" : "")) as any,');
fs.writeFileSync('src/adapters/supabase/helpers/issues.ts', issTs);

// 8. issue-scraper.ts
let scrapTs = fs.readFileSync('src/handlers/issue-scraper.ts', 'utf8');
scrapTs = scrapTs.replace(/const voyageEmbedding = context\.adapters\.voyage\?\.embedding;/g, 'const voyageEmbedding = context.adapters.nomic?.embedding ?? context.adapters.voyage?.embedding;');
scrapTs = scrapTs.replace(/embedding: serializeEmbeddingForDatabase\(embedding \?\? null\),/g, 'embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding ?? null),\n          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding ?? null) : null,\n          embedding_model: embedding?.length === 768 ? "nomic-embed-text-v1.5" : "voyage-4-large",\n          embedding_dim: embedding?.length ?? null,');
fs.writeFileSync('src/handlers/issue-scraper.ts', scrapTs);

// 9. embedding-queue.ts
let queueTs = fs.readFileSync('src/cron/embedding-queue.ts', 'utf8');
queueTs = queueTs.replace(/embedder: VoyageEmbedding/g, 'embedder: { createEmbeddings: (texts: string[]) => Promise<number[][]> }');
queueTs = queueTs.replace(/embedding: serializeEmbeddingForDatabase\(update\.embedding\)/g, 'embedding: update.embedding.length === 768 ? null : serializeEmbeddingForDatabase(update.embedding), embedding_nomic: update.embedding.length === 768 ? serializeEmbeddingForDatabase(update.embedding) : null, embedding_model: update.embedding.length === 768 ? "nomic-embed-text-v1.5" : "voyage-4-large", embedding_dim: update.embedding.length');
queueTs = queueTs.replace(/const voyageEmbedding = context\.adapters\.voyage\?\.embedding;/g, 'const voyageEmbedding = context.adapters.nomic?.embedding ?? context.adapters.voyage?.embedding;');
fs.writeFileSync('src/cron/embedding-queue.ts', queueTs);

console.log("[+] 代码注入完成！");
