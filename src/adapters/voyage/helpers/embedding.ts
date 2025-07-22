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
      const response = await this.client.embed({
        input: text,
        model: "voyage-large-2-instruct",
        inputType,
      });
      return (response.data && response.data[0]?.embedding) || [];
    }
  }
}
