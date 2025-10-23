declare namespace NodeJS {
  interface ProcessEnv {
    DISCORD_TOKEN: string;
    LLM_URL: string;
    LLM_API_KEY?: string;
  }
}
