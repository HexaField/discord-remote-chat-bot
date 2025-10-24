# GuildBot

A small TypeScript Discord bot that forwards structured JSON requests (e.g. CSV queries) to a remote LLM HTTP endpoint and posts the JSON response back.

Quick start

1. Copy `.env.example` to `.env` and set at least `DISCORD_TOKEN` and `LLM_URL` (optionally `LLM_API_KEY`, `GUILD_ID`, `CHANNEL_ID`, `CSV_PATH`, `MAX_CSV_ROWS`).
2. Install deps: `npm install`
3. Dev: `npm run dev` (hot reload)
4. Build: `npm run build` then `node dist/index.js`

For details about commands and CSV-to-LLM behavior, see the source in `src/`.

## Command-line interface (npx)

This project exposes a small CLI via `npx guildbot` which wraps the same logic used by the Discord bot. The CLI is a thin wrapper around the TypeScript sources and supports running from the compiled `dist/` or directly from `src/` (via `ts-node`).

Commands:

- Transcribe an audio file to text (uses `ffmpeg` + `whisper-cli`):

  ```bash
  npx guildbot transcribe /path/to/audio.m4a transcript.txt
  ```

- Extract a raw diagram (nodes + relationships) from a transcript:

  ```bash
  npx guildbot diagram transcript.txt graph.json
  ```

  Output format: JSON with two arrays: `{ "nodes": [...], "relationships": [...] }`.

- Convert the raw diagram into a Kumu-compatible JSON blueprint:

  ```bash
  npx guildbot kumu graph.json kumu.json
  ```

  `kumu.json` can be imported into Kumu via Import → Advanced → Import JSON file.

Requirements:

- `ffmpeg` and `whisper-cli` must be on your PATH.
- A Whisper model file must be present at `$WHISPER_MODEL` or `~/models/ggml-base.en.bin`.
- Ollama HTTP endpoint must be reachable at `$OLLAMA_URL` (defaults to `http://localhost:11434/api/generate`) and the chosen model available.

## Discord `/reflect` command

The bot registers a `/reflect` slash command (if `GUILD_ID` is set during startup). Use `/reflect` with a short free-text question (the command's `query` argument). The bot reads the CSV source configured by `CSV_PATH` (or `data/data.csv` by default), sends the CSV and your question to the configured LLM, and returns the model's string response.

## Discord `/diagram` command

The bot registers a `/diagram` slash command (if `GUILD_ID` is set during startup). Use it by attaching an audio file when invoking `/diagram`. The bot will:

- Download the audio attachment
- Convert it to 16kHz mono WAV and transcribe it with `whisper-cli`
- Extract nodes and relationships using the configured LLM
- Produce a Kumu JSON file and return the local path (or attach/upload if configured)

This command reuses the same pipeline as the CLI, so results should match between local runs and the bot.
