import fs from 'fs';

let envCode = fs.readFileSync('src/types/env.ts', 'utf8');
if (!envCode.includes('NOMIC_API_KEY')) {
    envCode = envCode.replace(
        'VOYAGEAI_API_KEY: T.String(),',
        'VOYAGEAI_API_KEY: T.Optional(T.String()),\n  NOMIC_API_KEY: T.Optional(T.String()),\n  EMBEDDING_MODEL: T.Optional(T.String({ default: "voyage-4-large" })),'
    );
    fs.writeFileSync('src/types/env.ts', envCode);
    console.log("[+] env.ts 注入 NOMIC_API_KEY 和 EMBEDDING_MODEL 成功");
} else {
    console.log("[-] env.ts 已包含 Nomic 配置");
}
