# Discord Remote Chat Bot — CSV Ask MVP

This small TypeScript project lets users in Discord ask a slash command `/ask` with a query and an optional CSV URL. The bot loads the CSV, builds a structured payload, and forwards it to a remote LLM service which should return a JSON response.

## How it works (MVP)
- User runs `/ask query:"..." csv_url:"https://.../data.csv"` in the designated channel.
- Bot fetches and parses the CSV (first N rows, default 50).
- Bot sends a structured `query_table` request to the LLM using the existing `callLLM` adapter.
- Bot replies with the LLM-provided answer.

## Environment variables
- `DISCORD_TOKEN` (required) — Discord bot token.
- `GUILD_ID` (optional) — registers commands in a guild during startup.
- `LLM_URL` (required) — HTTP endpoint for the LLM.
- `LLM_API_KEY` (optional) — Bearer token for the LLM.
- `CHANNEL_ID` (optional) — if set, only this channel may use `/ask`.
- `CSV_PATH` (optional) — local CSV fallback if `csv_url` not provided.
- `MAX_CSV_ROWS` (optional) — limit rows sent to the LLM (default 50).

## Commands
- `/json payload:<json>` — existing command, forwards arbitrary JSON to the LLM.
- `/ask query:<text> csv_url:<url>` — new command: query a CSV dataset.

## Development
Install deps and run tests:

```bash
npm install
npm test
```

Build:

```bash
npm run build
```

## Notes & next steps
- The LLM payload command is `query_table` with `params.table.columns` and `params.table.rows` (rows as arrays). Adjust your LLM prompt/handler to accept that shape.
- For large CSVs we currently send the first `MAX_CSV_ROWS`. We can add server-side filtering heuristics before sending to the LLM.
# Discord Remote Chat Bot (TypeScript)

Minimal Discord bot that accepts JSON commands and forwards them to an LLM HTTP endpoint that returns JSON. The bot expects the LLM to accept and return JSON in a predictable shape.

Environment

- Copy `.env.example` to `.env` and fill values:
  - `DISCORD_TOKEN` - Discord bot token
  - `LLM_URL` - HTTP URL of your LLM service
  - `LLM_API_KEY` - optional API key, sent as Bearer token

Commands

- `!json {"command":"name","params":{...}}` — sends the JSON to LLM and prints the JSON `data` field of the LLM response.

Build and run locally

Install deps and build:

```bash
npm install
npm run build
node dist/index.js
```

Run in development (hot reload):

```bash
npm run dev
```

Docker

Build image:

```bash
docker build -t discord-remote-chat-bot .
```

Run container (with .env):

```bash
docker run --env-file .env --rm discord-remote-chat-bot
```

LLM contract

The bot sends POST JSON: {"command":"...","params":{...}} and expects JSON response of shape:

{
  "success": boolean,
  "data": any, // present when success=true
  "error": string // present when success=false
}

This keeps input/output machine-parsable and verifiable.

Testing

This repo includes a small unit test for the LLM client (`callLLM`). To run tests locally:

```bash
npm install
npm test
```

The tests start a tiny local HTTP server to mock the LLM endpoint and verify the success and invalid-shape flows.
