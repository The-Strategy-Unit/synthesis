# Developer Guide

Setup, configuration, extending, and troubleshooting for Synthesis.

## Prerequisites

- [Deno](https://deno.land) ≥ 2.0
- [Ollama](https://ollama.com) running locally (or a remote OpenAI-compatible
  endpoint)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube ingestion

## Setup

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup
deno task start
```

`setup.ts` will:

1. Check that Ollama is running (exits with install instructions if not)
2. Check for yt-dlp and warn if it must be installed
3. Check every configured model role and report models that must be pulled
4. Create the vault directory at `~/Synthesis/notes`

## Development

```bash
deno task dev      # auto-reload via --watch
deno task lint     # deno lint --fix && deno fmt
deno task test:unit          # fast, permissionless logic tests
deno task test:integration   # database, route, and orchestration tests
```

### Permissions

`scripts/start.ts` grants the child runtime:

- `--allow-net` because validated provider endpoints can be configured at
  runtime
- `--allow-ffi` - sqlite-vec native extension
- `--allow-read=web,$vaultDir,$appDataDir,$tmpDir`
- `--allow-write=$vaultDir,$appDataDir,$tmpDir`
- `--allow-run=yt-dlp`
- `--allow-env` restricted to documented Synthesis and platform path variables

Application validation limits provider API bases to HTTPS endpoints ending in
`/v1`, except that loopback HTTP is allowed for local providers.

See [Private Alpha Deployment](DEPLOYMENT.md) for the authentication, quota,
backup, and reverse-proxy configuration.

## Configuration reference

All config lives in `src/config.ts`. Every value has an environment variable
override with validation (clamping, enum checks, minimum bounds).

### Core

| Variable          | Default       | Validation      |
| ----------------- | ------------- | --------------- |
| `SYNTHESIS_VAULT` | `~/Synthesis` | -               |
| `SYNTHESIS_PORT`  | `8000`        | clamped 1–65535 |

### LLM API

| Variable                     | Default                     | Notes                          |
| ---------------------------- | --------------------------- | ------------------------------ |
| `SYNTHESIS_API_BASE`         | `http://localhost:11434/v1` | OpenAI-compatible endpoint     |
| `SYNTHESIS_API_KEY`          | `ollama`                    | Bearer token                   |
| `SYNTHESIS_REASONING_EFFORT` | `none`                      | `high\|medium\|low\|max\|none` |

### Model roles

| Variable                      | Default       | Used by                             |
| ----------------------------- | ------------- | ----------------------------------- |
| `SYNTHESIS_EXTRACT_MODEL`     | `qwen3.5:9b`  | Per-chunk extraction                |
| `SYNTHESIS_CONSOLIDATE_MODEL` | `qwen3.6:27b` | Source-level consolidation          |
| `SYNTHESIS_INTEGRATE_MODEL`   | `qwen3.5:9b`  | new/merge/contradict decisions      |
| `SYNTHESIS_REWRITE_MODEL`     | `qwen3.6:27b` | Rewriting existing notes            |
| `SYNTHESIS_LLM_MODEL`         | `qwen3.6:27b` | Backward-compat / API response only |

### LLM tuning

| Variable                            | Default | Validation  |
| ----------------------------------- | ------- | ----------- |
| `SYNTHESIS_LLM_TEMPERATURE`         | `0.1`   | clamped 0–2 |
| `SYNTHESIS_EXTRACT_TEMPERATURE`     | `0.2`   | clamped 0–2 |
| `SYNTHESIS_CONSOLIDATE_TEMPERATURE` | `0.1`   | clamped 0–2 |
| `SYNTHESIS_INTEGRATE_TEMPERATURE`   | `0.1`   | clamped 0–2 |
| `SYNTHESIS_EXTRACT_MAX_TOKENS`      | `2000`  | min 256     |
| `SYNTHESIS_CONSOLIDATE_MAX_TOKENS`  | `4000`  | min 256     |
| `SYNTHESIS_INTEGRATE_MAX_TOKENS`    | `2000`  | min 256     |
| `SYNTHESIS_REWRITE_MAX_TOKENS`      | `2000`  | min 256     |
| `SYNTHESIS_MAX_TOKENS`              | `800`   | min 256     |

### Embeddings

| Variable                     | Default                       | Notes                           |
| ---------------------------- | ----------------------------- | ------------------------------- |
| `SYNTHESIS_EMBED_API_BASE`   | inherits `SYNTHESIS_API_BASE` | Separate endpoint if needed     |
| `SYNTHESIS_EMBED_API_KEY`    | inherits `SYNTHESIS_API_KEY`  | -                               |
| `SYNTHESIS_EMBED_MODEL`      | `qwen3-embedding:8b`          | -                               |
| `SYNTHESIS_EMBED_DIMENSIONS` | `4096`                        | min 64; must match model output |

### Ingest

| Variable                   | Default  | Notes                 |
| -------------------------- | -------- | --------------------- |
| `SYNTHESIS_MAX_CHARS`      | `12000`  | min 1000; chunk size  |
| `SYNTHESIS_CHUNK_OVERLAP`  | `500`    | clamped 0–2000        |
| `SYNTHESIS_YT_DLP_PATH`    | `yt-dlp` | downloader executable |
| `SYNTHESIS_SUBTITLES_LANG` | `en`     | yt-dlp `--sub-lang`   |

### Linking

| Variable                   | Default | Notes                          |
| -------------------------- | ------- | ------------------------------ |
| `SYNTHESIS_LINK_THRESHOLD` | `0.75`  | clamped 0–1; cosine similarity |
| `SYNTHESIS_LINK_K`         | `50`    | min 1; kNN fanout per note     |

### Search

| Variable                 | Default | Notes              |
| ------------------------ | ------- | ------------------ |
| `SYNTHESIS_SEARCH_LIMIT` | `20`    | min 1; max results |

### UI

| Variable                         | Default | Notes           |
| -------------------------------- | ------- | --------------- |
| `SYNTHESIS_LABEL_ZOOM_THRESHOLD` | `1.5`   | clamped 0–10    |
| `SYNTHESIS_SLIDER_MIN`           | `0`     | clamped 0–1     |
| `SYNTHESIS_SLIDER_MAX`           | `1`     | clamped 0–1     |
| `SYNTHESIS_SLIDER_STEP`          | `0.025` | clamped 0.001–1 |

## Extending

### Adding a new ingestion source

1. Add a function to `src/ingest.ts` returning `IngestResult`:
   ```typescript
   {
     transcript: string;
     sourceUrl: string;
     title: string;
   }
   ```
2. Wire it into the `POST /api/ingest` handler in `src/routes.ts`
3. Preserve immutable-source and note provenance in `src/orchestrate.ts`

### Customizing the distillation prompt

Edit the prompt constants in `src/distil.ts`:

- `EXTRACT_PROMPT` - per-chunk extraction
- `CONSOLIDATE_PROMPT` - source-level consolidation
- Integrate and rewrite prompts are inline in their respective functions

### Changing the embedding model

Set `SYNTHESIS_EMBED_MODEL` and ensure `SYNTHESIS_EMBED_DIMENSIONS` matches the
model's output. Existing embeddings will have mismatched dimensions and must be
regenerated (delete the `embeddings` table or rebuild from scratch).

## API reference

See the README for the endpoint table. Additional details:

### `POST /api/ingest` (SSE)

Request body: `{ "url": "..." }` or `{ "text": "...", "title": "..." }`

Response is a `text/event-stream` with `data:` events:

| Stage         | Data                         |
| ------------- | ---------------------------- |
| `ingesting`   | `{ title }`                  |
| `ingested`    | `{ title }`                  |
| `extracting`  | -                            |
| `distilled`   | `{ noteCount }`              |
| `embedding`   | -                            |
| `integrating` | -                            |
| `integrated`  | `{ new, merge, contradict }` |
| `linking`     | -                            |
| `done`        | `{ notes: [{ id, title }] }` |
| `error`       | `{ error }`                  |

### `POST /api/ingest/playlist` (SSE)

Request body: `{ "url": "https://youtube.com/playlist?list=..." }`

Same SSE stages, but with `distilling` events per video
(`{ title: "Video N/M" }`) and an `errors` array in the `done` event.

### `GET /api/search`

Query parameters:

- `q` - search query (required)
- `mode` - `semantic` (default) or `keyword`

Returns `{ results: [{ id, title, score, matchType }], query }`.
