# UI

Development UI providing a web interface to browse downloaded YouTube videos processed by audio-to-diagram.

## Structure

- `server/`: Express server exposing APIs for video list, transcripts, and graph data.
- `web/`: Vite + SolidJS + Tailwind client consuming the APIs and rendering iframe, transcript, and graph.

## Dev

From repo root install dependencies (creates UI deps):

```bash
npm install
```

Run UI dev (server + client concurrently):

```bash
npm run ui:dev
```
