import fs from 'fs';

const sourceSql = fs.readFileSync('supabase/migrations/20251223045000_unify_documents.sql', 'utf8');

// 提取所有的 RPC 函数创建语句
const functionRegex = /CREATE OR REPLACE FUNCTION (find_similar_[a-z_]+)\((.*?)\)[\s\S]*?\$\$ LANGUAGE plpgsql;/g;
let nomicFunctions = "";

let match;
while ((match = functionRegex.exec(sourceSql)) !== null) {
    let funcBody = match[0];
    // 替换函数名，追加 _nomic
    funcBody = funcBody.replace(/FUNCTION (find_similar_[a-z_]+)\(/, "FUNCTION $1_nomic(");
    // 替换维度 1024 -> 768
    funcBody = funcBody.replace(/vector\(1024\)/g, "vector(768)");
    // 替换列名 embedding -> embedding_nomic
    funcBody = funcBody.replace(/ embedding /g, " embedding_nomic ");
    funcBody = funcBody.replace(/, embedding\)/g, ", embedding_nomic)");
    funcBody = funcBody.replace(/\(embedding <=>/g, "(embedding_nomic <=>");
    funcBody = funcBody.replace(/embedding IS NOT NULL/g, "embedding_nomic IS NOT NULL");
    
    nomicFunctions += funcBody + "\n\n";
}

const migrationSql = `-- Add Nomic embedding column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_nomic vector(768);

-- Create index for Nomic embeddings
CREATE INDEX IF NOT EXISTS documents_embedding_nomic_ivfflat
  ON public.documents USING ivfflat (embedding_nomic vector_cosine_ops)
  WITH (lists='10');

-- Nomic Specific RPC Functions
${nomicFunctions}
`;

fs.writeFileSync('supabase/migrations/20251224000000_nomic_support.sql', migrationSql);
console.log("[+] 成功生成 20251224000000_nomic_support.sql");
