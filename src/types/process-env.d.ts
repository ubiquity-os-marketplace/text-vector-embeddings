declare global {
  namespace NodeJS {
    interface ProcessEnv {
      GITHUB_TOKEN: string;
      DATABASE_URL?: string;
    }
  }
}

export {};
