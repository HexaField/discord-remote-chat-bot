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
