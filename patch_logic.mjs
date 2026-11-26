import fs from 'fs';

function patchFile(path, patcher) {
    let code = fs.readFileSync(path, 'utf8');
    let newCode = patcher(code);
    if (code !== newCode) {
        fs.writeFileSync(path, newCode);
        console.log(`[+] Patched ${path}`);
    } else {
        console.log(`[-] No changes made to ${path}`);
    }
}

// 1. embedding-queue.ts
patchFile('src/cron/embedding-queue.ts', (code) => {
    code = code.replace(/embedder: VoyageEmbedding/g, 'embedder: any');
    code = code.replace(
        /embedding: serializeEmbeddingForDatabase\(update\.embedding\)/g,
        `embedding: update.embedding.length === 768 ? null : serializeEmbeddingForDatabase(update.embedding),
          embedding_nomic: update.embedding.length === 768 ? serializeEmbeddingForDatabase(update.embedding) : null,
          embedding_model: update.embedding.length === 768 ? 'nomic-embed-text-v1.5' : 'voyage-4-large',
          embedding_dim: update.embedding.length`
    );
    return code;
});

// 2. issue-scraper.ts
patchFile('src/handlers/issue-scraper.ts', (code) => {
    code = code.replace(
        /const voyageEmbedding = context\.adapters\.voyage\?\.embedding;/g,
        `const voyageEmbedding = context.adapters.nomic?.embedding ?? context.adapters.voyage?.embedding;`
    );
    code = code.replace(
        /embedding: serializeEmbeddingForDatabase\(embedding \?\? null\),/g,
        `embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding ?? null),
          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding ?? null) : null,
          embedding_model: embedding?.length === 768 ? 'nomic-embed-text-v1.5' : 'voyage-4-large',
          embedding_dim: embedding?.length ?? null,`
    );
    return code;
});

// 3. comment.ts
patchFile('src/adapters/supabase/helpers/comment.ts', (code) => {
    code = code.replace(
        /embedding: serializeEmbeddingForDatabase\(embedding\),/g,
        `embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding),
          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding) : null,
          embedding_model: embedding?.length === 768 ? 'nomic-embed-text-v1.5' : 'voyage-4-large',
          embedding_dim: embedding?.length ?? null,`
    );
    code = code.replace(
        /this\.context\.adapters\.voyage\.embedding/g,
        `(this.context.adapters.nomic?.embedding ?? this.context.adapters.voyage.embedding)`
    );
    code = code.replace(
        /this\.supabase\.rpc\("([^"]+)",/g,
        `this.supabase.rpc(("$1" + (embedding.length === 768 ? "_nomic" : "")) as any,`
    );
    return code;
});

// 4. issues.ts
patchFile('src/adapters/supabase/helpers/issues.ts', (code) => {
    code = code.replace(
        /embedding: serializeEmbeddingForDatabase\(embedding\),/g,
        `embedding: embedding?.length === 768 ? null : serializeEmbeddingForDatabase(embedding),
          embedding_nomic: embedding?.length === 768 ? serializeEmbeddingForDatabase(embedding) : null,
          embedding_model: embedding?.length === 768 ? 'nomic-embed-text-v1.5' : 'voyage-4-large',
          embedding_dim: embedding?.length ?? null,`
    );
    code = code.replace(
        /this\.context\.adapters\.voyage\.embedding/g,
        `(this.context.adapters.nomic?.embedding ?? this.context.adapters.voyage.embedding)`
    );
    code = code.replace(
        /this\.supabase\.rpc\("([^"]+)",/g,
        `this.supabase.rpc(("$1" + (embedding.length === 768 ? "_nomic" : "")) as any,`
    );
    return code;
});
