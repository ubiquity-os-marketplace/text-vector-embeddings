import fs from 'fs';

let indexTs = fs.readFileSync('src/adapters/index.ts', 'utf8');

if (!indexTs.includes('NomicEmbedding')) {
    indexTs = indexTs.replace(
        'import { SuperVoyage } from "./voyage/helpers/voyage";',
        'import { SuperVoyage } from "./voyage/helpers/voyage";\nimport { Embedding as NomicEmbedding } from "./nomic/helpers/embedding";\nimport { SuperNomic } from "./nomic/helpers/nomic";'
    );

    indexTs = indexTs.replace(
        'voyage: {',
        'nomic?: {\n    embedding: NomicEmbedding;\n    super: SuperNomic;\n  };\n  voyage: {'
    );

    indexTs = indexTs.replace(
        'voyage: {',
        'nomic: context.env.NOMIC_API_KEY ? {\n      embedding: new NomicEmbedding(context.env.NOMIC_API_KEY, context),\n      super: new SuperNomic(context.env.NOMIC_API_KEY, context),\n    } : undefined,\n    voyage: {'
    );

    fs.writeFileSync('src/adapters/index.ts', indexTs);
    console.log("[+] src/adapters/index.ts 注册 Nomic 成功！");
} else {
    console.log("[-] src/adapters/index.ts 已包含 Nomic 配置");
}
