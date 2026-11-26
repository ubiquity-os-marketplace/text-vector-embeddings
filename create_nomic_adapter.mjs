import fs from 'fs';

fs.mkdirSync('src/adapters/nomic/helpers', { recursive: true });

const nomicTs = `import { Context } from "../../../types/context";

export class SuperNomic {
  protected apiKey: string;
  protected context: Context;

  constructor(apiKey: string, context: Context) {
    this.apiKey = apiKey;
    this.context = context;
  }
}
`;
fs.writeFileSync('src/adapters/nomic/helpers/nomic.ts', nomicTs);

const embeddingTs = `import { Context } from "../../../types/index";
import { SuperNomic } from "./nomic";

export class Embedding extends SuperNomic {
  constructor(apiKey: string, context: Context) {
    super(apiKey, context);
  }

  async createEmbedding(text: string | null): Promise<number[]> {
    if (!text) {
      throw new Error("Text is null");
    }
    // 安全截断防线：防止超长 GitHub 评论导致 HTTP 413/400 (Nomic 限制 8192 tokens)
    const truncated = text.length > 25000 ? text.slice(0, 25000) : text;
    
    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${this.apiKey}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "nomic-embed-text-v1.5",
        texts: [truncated],
        task_type: "search_document"
      })
    });
    
    if (!response.ok) {
      this.context.logger.error(\`Nomic API Error: \${response.statusText}\`);
      return [];
    }
    
    const data = await response.json();
    return data.embeddings?.[0] ?? [];
  }

  async createEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    
    const truncatedTexts = texts.map(t => t.length > 25000 ? t.slice(0, 25000) : t);
    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${this.apiKey}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "nomic-embed-text-v1.5",
        texts: truncatedTexts,
        task_type: "search_document"
      })
    });
    
    if (!response.ok) {
      this.context.logger.error(\`Nomic API Error: \${response.statusText}\`);
      return [];
    }

    const data = await response.json();
    return data.embeddings ?? [];
  }
}
`;
fs.writeFileSync('src/adapters/nomic/helpers/embedding.ts', embeddingTs);
console.log("[+] Nomic 适配器与截断防线创建完毕！");
