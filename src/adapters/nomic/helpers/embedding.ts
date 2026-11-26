import { Context } from "../../../types/index";
import { SuperNomic } from "./nomic";
import { encoding_for_model } from "tiktoken";

export class Embedding extends SuperNomic {
  constructor(apiKey: string, context: Context) {
    super(apiKey, context);
  }

  private _truncateToTokens(text: string, maxTokens: number): string {
    const enc = encoding_for_model("text-embedding-3-small");
    const tokens = enc.encode(text);
    if (tokens.length <= maxTokens) {
      enc.free();
      return text;
    }
    const truncated = new TextDecoder().decode(enc.decode(tokens.slice(0, maxTokens)));
    enc.free();
    return truncated;
  }

  async createEmbedding(text: string | null): Promise<number[]> {
    if (!text) throw new Error("Text is null");
    const truncated = this._truncateToTokens(text, 8100);

    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: [truncated], task_type: "search_document" }),
    });

    if (!response.ok) {
      this.context.logger.error(`Nomic API Error: ${response.statusText}`);
      return [];
    }
    const data = await (response.json() as Promise<{ embeddings?: number[][] }>);
    return data.embeddings?.[0] ?? [];
  }

  async createEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const truncatedTexts = texts.map((t) => this._truncateToTokens(t, 8100));
    const response = await fetch("https://api.nomic.ai/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text-v1.5", texts: truncatedTexts, task_type: "search_document" }),
    });

    if (!response.ok) {
      this.context.logger.error(`Nomic API Error: ${response.statusText}`);
      return [];
    }
    const data = await (response.json() as Promise<{ embeddings?: number[][] }>);
    return data.embeddings ?? [];
  }
}
