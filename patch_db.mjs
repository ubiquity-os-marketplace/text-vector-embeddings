import fs from 'fs';

let dbCode = fs.readFileSync('src/types/database.ts', 'utf8');
if (!dbCode.includes('embedding_nomic:')) {
    dbCode = dbCode.replace(/embedding: string \| null;/g, 'embedding: string | null;\n          embedding_nomic: string | null;');
    fs.writeFileSync('src/types/database.ts', dbCode);
    console.log("[+] database.ts 注入 embedding_nomic 成功");
} else {
    console.log("[-] database.ts 已包含 embedding_nomic");
}
