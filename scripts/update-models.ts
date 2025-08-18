import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

async function fetchAndUpdateModels(): Promise<void> {
  try {
    console.log("Fetching available models from OpenRouter...");

    const response = await fetch("https://openrouter.ai/api/v1/models");
    const data = (await response.json()) as OpenRouterResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from OpenRouter API");
    }

    const modelIds = data.data.map((model: OpenRouterModel) => model.id).sort((a, b) => a.localeCompare(b));
    console.log(`Found ${modelIds.length} models`);

    const pluginInputPath = path.join(dirname, "../src/types/openrouter-types.ts");

    const newExamples = `export const llmList = [
        // cspell:disable
${modelIds.map((model) => `"${model}"`).join(",\n")},
        // cspell:enable
      ]`;

    fs.writeFileSync(pluginInputPath, newExamples, { flag: "w+" });
    console.log(`Updated model examples in plugin-input.ts with ${modelIds.length} models`);
  } catch (error) {
    console.error("Error updating models:", (error as Error).message);
    process.exit(1);
  }
}

fetchAndUpdateModels().catch((error) => {
  console.error("Failed to update models:", error);
  process.exit(1);
});
