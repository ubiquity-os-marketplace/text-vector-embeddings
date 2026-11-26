import { Context } from "../../../types/context";
export class SuperNomic {
  protected apiKey: string;
  protected context: Context;
  constructor(apiKey: string, context: Context) {
    this.apiKey = apiKey;
    this.context = context;
  }
}
