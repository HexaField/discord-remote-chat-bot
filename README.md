# discord-remote-chat-bot

A small TypeScript Discord bot that forwards structured JSON requests (e.g. CSV queries) to a remote LLM HTTP endpoint and posts the JSON response back.

Quick start

1. Copy `.env.example` to `.env` and set at least `DISCORD_TOKEN` and `LLM_URL` (optionally `LLM_API_KEY`, `GUILD_ID`, `CHANNEL_ID`, `CSV_PATH`, `MAX_CSV_ROWS`).
2. Install deps: `npm install`
3. Dev: `npm run dev` (hot reload)
4. Build: `npm run build` then `node dist/index.js`

For details about commands and CSV-to-LLM behavior, see the source in `src/`.
