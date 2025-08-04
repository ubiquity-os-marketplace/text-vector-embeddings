import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/main.ts", "src/worker.ts", "src/cron/index.ts", "scripts/**/*.ts"],
  project: ["src/**/*.ts", "scripts/**/*.ts"],
  ignore: [
    "src/types/config.ts",
    "**/__mocks__/**",
    "**/__fixtures__/**",
    "src/types/database.ts",
    "src/handlers/user-issue-scraper.ts",
    "src/handlers/issue-scraper.ts",
  ],
  ignoreExportsUsedInFile: true,
  // eslint can also be safely ignored as per the docs: https://knip.dev/guides/handling-issues#eslint--jest
  ignoreDependencies: ["eslint-config-prettier", "eslint-plugin-prettier", "ts-node", "@mswjs/data"],
  eslint: true,
};

export default config;
