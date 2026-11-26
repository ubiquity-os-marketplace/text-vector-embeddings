import { Context } from "../../../types/index";
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
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: [truncated], task_type: "search_document" })
    });
    
    if (!response.ok) {
      this.context.logger.error(`Nomic API Error: ${response.statusText}`);
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
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: truncatedTexts, task_type: "search_document" })
    });
    
    if (!response.ok) {
      this.context.logger.error(`Nomic API Error: ${response.statusText}`);
      return [];
    }
    const data = await (response.json() as Promise<any>);
    return data.embeddings ?? [];
  }
}
