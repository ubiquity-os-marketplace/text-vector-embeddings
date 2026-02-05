import { VoyageAIClient } from "voyageai";
import { EmbedRequestInputType } from "voyageai/api/types/EmbedRequestInputType.js";
import { Context } from "../../../types/index";
import { SuperVoyage } from "./voyage";

export class Embedding extends SuperVoyage {
  protected context: Context;

  constructor(client: VoyageAIClient, context: Context) {
    super(client, context);
    this.context = context;
  }

  async createEmbedding(text: string | null, inputType: EmbedRequestInputType = "document"): Promise<number[]> {
    if (text === null) {
      throw new Error("Text is null");
    } else {
      const embeddings = await this.createEmbeddings([text], inputType);
      return embeddings[0] ?? [];
    }
  }

  async createEmbeddings(texts: string[], inputType: EmbedRequestInputType = "document"): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.client.embed({
      input: texts,
      model: "voyage-4-large",
      outputDimension: 1024,
      inputType,
    });
    if (!response.data) {
      return [];
    }
    return response.data.map((item) => item?.embedding ?? []);
  }
}
