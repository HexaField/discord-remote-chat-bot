declare namespace NodeJS {
  interface ProcessEnv {
    DISCORD_TOKEN: string
    LLM_URL: string
    LLM_API_KEY?: string
    RECORDING_TRANSCRIPT_CHANNEL_ID?: string
    CHANNEL_ID?: string
    CSV_PATH?: string
    MAX_CSV_ROWS?: string
  }
}
