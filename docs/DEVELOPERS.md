# Developer Guide

Setup, configuration, extending, and troubleshooting for Synthesis.

## Prerequisites

- [Deno](https://deno.land) ≥ 2.0; Deno 2.9.5 or later for QuickJS compilation
- [Ollama](https://ollama.com) running locally (or a remote OpenAI-compatible
  endpoint)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube ingestion

## Setup

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup
deno task app
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
deno task test:e2e           # provider-independent server/UI workflow tests
```

Compile a self-extracting QuickJS executable for the current host with
`deno task compile`, or cross-compile Windows x64 with
`deno task compile:windows`. Run `deno task test:compiled <executable>` on the
artifact's target operating system to verify native SQLite startup, offline
vault APIs, and embedded UI assets from an unrelated working directory.

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

See [Private Beta Deployment](DEPLOYMENT.md) for the authentication, quota,
backup, and reverse-proxy configuration.

## Configuration reference

All config lives in `src/config.ts`. Every value has an environment variable
override with validation (clamping, enum checks, minimum bounds).

### Core

| Variable                 | Default       | Validation/notes                    |
| ------------------------ | ------------- | ----------------------------------- |
| `SYNTHESIS_VAULT`        | `~/Synthesis` | Authoritative vault root            |
| `SYNTHESIS_APP_DATA`     | platform data | Provider profile and secret service |
| `SYNTHESIS_HOST`         | `127.0.0.1`   | Listener address                    |
| `SYNTHESIS_PORT`         | `8000`        | clamped 1–65535                     |
| `SYNTHESIS_OPEN_BROWSER` | `true`        | Launcher behaviour                  |

### Access, limits, and quotas

| Variable                                 | Default | Validation/notes                       |
| ---------------------------------------- | ------- | -------------------------------------- |
| `SYNTHESIS_PUBLIC_ORIGIN`                | unset   | Required for protected network hosting |
| `SYNTHESIS_TRUST_PROXY_AUTH`             | `false` | Trust Cloudflare identity header       |
| `SYNTHESIS_ALLOWED_EMAILS`               | empty   | Comma-separated viewers                |
| `SYNTHESIS_INGESTER_EMAILS`              | empty   | Comma-separated mutation identities    |
| `SYNTHESIS_MAX_BODY_BYTES`               | 1 MiB   | clamped 1 KiB–10 MiB                   |
| `SYNTHESIS_MAX_UPLOAD_BYTES`             | 25 MiB  | clamped 1–100 MiB                      |
| `SYNTHESIS_MAX_PASTED_TEXT_CHARS`        | 250000  | clamped 1000–1,000,000                 |
| `SYNTHESIS_MAX_TITLE_CHARS`              | 200     | clamped 20–1000                        |
| `SYNTHESIS_MAX_SEARCH_CHARS`             | 500     | clamped 20–5000                        |
| `SYNTHESIS_MAX_TRANSCRIPT_CHARS`         | 500000  | clamped 1000–2,000,000                 |
| `SYNTHESIS_MAX_SUBTITLE_BYTES`           | 10 MiB  | clamped 1–100 MiB                      |
| `SYNTHESIS_YT_DLP_TIMEOUT_MS`            | 120000  | clamped 5 seconds–30 minutes           |
| `SYNTHESIS_MODEL_TIMEOUT_MS`             | 180000  | clamped 5 seconds–30 minutes           |
| `SYNTHESIS_INGEST_QUEUE_SIZE`            | 4       | clamped 0–100                          |
| `SYNTHESIS_PER_USER_DAILY_JOBS`          | 5       | clamped 1–10000                        |
| `SYNTHESIS_GLOBAL_DAILY_JOBS`            | 20      | clamped 1–100000                       |
| `SYNTHESIS_SEMANTIC_SEARCHES_PER_MINUTE` | 5       | clamped 1–1000                         |

### LLM API

| Variable                     | Default                     | Notes                          |
| ---------------------------- | --------------------------- | ------------------------------ |
| `SYNTHESIS_API_BASE`         | `http://localhost:11434/v1` | OpenAI-compatible endpoint     |
| `SYNTHESIS_API_KEY`          | `ollama`                    | Bearer token                   |
| `SYNTHESIS_REASONING_EFFORT` | `none`                      | `high\|medium\|low\|max\|none` |

### Model roles

| Variable                      | Default      | Used by                             |
| ----------------------------- | ------------ | ----------------------------------- |
| `SYNTHESIS_EXTRACT_MODEL`     | `qwen3.5:9b` | Per-chunk extraction                |
| `SYNTHESIS_CONSOLIDATE_MODEL` | `qwen3.5:9b` | Source-level consolidation          |
| `SYNTHESIS_INTEGRATE_MODEL`   | `qwen3.5:9b` | new/merge/contradict decisions      |
| `SYNTHESIS_REWRITE_MODEL`     | `qwen3.5:9b` | Rewriting existing notes            |
| `SYNTHESIS_LLM_MODEL`         | `qwen3.5:9b` | Backward-compat / API response only |

### LLM tuning

| Variable                            | Default | Validation  |
| ----------------------------------- | ------- | ----------- |
| `SYNTHESIS_LLM_TEMPERATURE`         | `0.1`   | clamped 0–2 |
| `SYNTHESIS_EXTRACT_TEMPERATURE`     | `0`     | clamped 0–2 |
| `SYNTHESIS_CONSOLIDATE_TEMPERATURE` | `0.1`   | clamped 0–2 |
| `SYNTHESIS_INTEGRATE_TEMPERATURE`   | `0.1`   | clamped 0–2 |
| `SYNTHESIS_EXTRACT_MAX_TOKENS`      | `2000`  | min 256     |
| `SYNTHESIS_CONSOLIDATE_MAX_TOKENS`  | `4000`  | min 256     |
| `SYNTHESIS_INTEGRATE_MAX_TOKENS`    | `2000`  | min 256     |
| `SYNTHESIS_REWRITE_MAX_TOKENS`      | `2000`  | min 256     |
| `SYNTHESIS_MAX_TOKENS`              | `800`   | min 256     |

### Embeddings

| Variable                     | Default                          | Notes                           |
| ---------------------------- | -------------------------------- | ------------------------------- |
| `SYNTHESIS_EMBED_API_BASE`   | inherits `SYNTHESIS_API_BASE`    | Separate endpoint if needed     |
| `SYNTHESIS_EMBED_API_KEY`    | inherits `SYNTHESIS_API_KEY`     | -                               |
| `SYNTHESIS_EMBED_MODEL`      | `nomic-embed-text-v2-moe:latest` | -                               |
| `SYNTHESIS_EMBED_DIMENSIONS` | `768`                            | min 64; must match model output |

### Ingest

| Variable                            | Default                            | Notes                   |
| ----------------------------------- | ---------------------------------- | ----------------------- |
| `SYNTHESIS_MAX_CHARS`               | `12000`                            | min 1000; chunk size    |
| `SYNTHESIS_CHUNK_OVERLAP`           | `500`                              | clamped 0–2000          |
| `SYNTHESIS_MAX_UPLOAD_BYTES`        | `26214400`                         | clamped 1–100 MiB       |
| `SYNTHESIS_MAX_PDF_PAGES`           | `500`                              | clamped 1–5000          |
| `SYNTHESIS_PDF_PARSE_TIMEOUT_MS`    | `30000`                            | clamped 1 second–5 mins |
| `SYNTHESIS_YT_DLP_PATH`             | `yt-dlp` (`yt-dlp.exe` on Windows) | downloader executable   |
| `SYNTHESIS_SUBTITLES_LANG`          | `en`                               | yt-dlp `--sub-lang`     |
| `SYNTHESIS_PLAYLIST_ENABLED`        | `true`                             | enable playlist route   |
| `SYNTHESIS_MAX_PLAYLIST_ITEMS`      | `10`                               | clamped 1–100           |
| `SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS` | `100`                              | clamped 1–100           |

### Linking

| Variable                    | Default | Notes                                       |
| --------------------------- | ------- | ------------------------------------------- |
| `SYNTHESIS_LINK_K`          | `8`     | clamped 1–32; stored neighbours per page    |
| `SYNTHESIS_GRAPH_NEIGHBORS` | `3`     | clamped 0–32 and capped to the stored count |

### Search

| Variable                 | Default | Notes              |
| ------------------------ | ------- | ------------------ |
| `SYNTHESIS_SEARCH_LIMIT` | `20`    | min 1; max results |

### UI

| Variable                         | Default | Notes        |
| -------------------------------- | ------- | ------------ |
| `SYNTHESIS_LABEL_ZOOM_THRESHOLD` | `1.5`   | clamped 0–10 |

## Extending

### Adding a new ingestion source

1. Add a function to `src/ingest.ts` returning `IngestResult`:
   ```typescript
   {
     transcript: string;
     sourceUrl: string;
     title: string;
     sourceType: "youtube" | "text" | "markdown" | "pdf";
     originalFile?: { fileName: string; mediaType: string; bytes: Uint8Array };
     pageCount?: number;
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
model's output. Provider URL, model, and dimensions form the derived semantic
index identity. Selecting a different identity invalidates embeddings and links
instead of mixing incompatible vector spaces. Use **Build semantic index** or
`POST /api/semantic-index/rebuild` to repopulate the vault in bounded resumable
batches. A different vector width still requires a new database because the
sqlite-vec virtual-table width is fixed.

## API reference

See the README for the endpoint table. Additional details:

### `POST /api/ingest` (SSE)

Request body: `{ "url": "..." }` or `{ "text": "...", "title": "..." }`

Response is a `text/event-stream` with `data:` events:

| Stage        | Data                                        |
| ------------ | ------------------------------------------- |
| `ingesting`  | `{ title }`                                 |
| `ingested`   | `{ title }`                                 |
| `extracting` | -                                           |
| `distilled`  | `{ noteCount }`                             |
| `proposal`   | `{ proposal, new, merge, contradict }`      |
| `done`       | `{ notes: [] }` for a newly staged proposal |
| `error`      | `{ error, code, requestId }`                |

Staging archives the source but does not mutate wiki pages. A reviewer inspects
the proposal through `GET /api/proposals/:id` and applies it with
`POST /api/proposals/:id/approve`. Manual approval must contain a non-empty
`changes` array with exact reviewed proposal indexes and optional edited body
text; `{}` is rejected. The separately confirmed trusted-batch path is the only
flow that selects every staged change automatically. Approval streams
`embedding`, `integrating`, `integrated`, `linking`, optional cross-source
`discoveries` or `warning`, and `done` events. The synthesis pass treats
accepted pages as seeds but compares them with candidates from other sources
across the vault. Reject a pending proposal with
`POST /api/proposals/:id/reject`.

### `POST /api/ingest/batch` (SSE)

Request body:

```json
{
  "urls": ["<YouTube video ID or URL>", "<another video URL>"],
  "reviewMode": "automatic",
  "confirm": "AUTO APPLY 2 TRUSTED SOURCES"
}
```

The server normalizes and rejects duplicate videos, enforces
`SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS`, and requires the exact count-specific
confirmation. It resolves one provider configuration, then processes sources
sequentially through the ordinary stage, validation, stale-hash, embedding,
history, and recoverable-apply path. Every proposed change is selected. The
stream adds `batch_started`, `batch_source`, `automatic_proposal`,
`automatic_applied`, optional `batch_skipped`, `synthesizing`, optional
`synthesis_progress`, `discoveries`, and `batch_complete` events. Cross-source
synthesis runs a resumable candidate generation over the completed vault rather
than once after every trusted video. It continues bounded model chunks until the
current frontier is complete; its proposals remain pending for human review.

The batch stops at the first source or apply failure. Cross-source synthesis
failures after committed sources remain warnings. Re-submit the same list to
resume; applied source identities are skipped, while a pending proposal is
staged again and automatically applied. Automatic history records contain
`reviewMode` and the shared `batchId`. Clients must keep the SSE request open.

### Export, rebuild, and undo

`GET /api/export` streams the authoritative vault as tar. The exporter rejects
symlinks and unsafe/overlong archive paths and excludes SQLite and app-data
secrets. Its test extracts the archive into a fresh vault, creates a new SQLite
database, rebuilds the catalog, and verifies keyword search.

`POST /api/rebuild` requires `{ "confirm": "REBUILD" }`. Files are fully
preflighted before `DB.replaceCatalog()` transactionally replaces derived rows.
Rebuild clears embeddings, semantic links, proposals, discovery candidate
coverage, and discoveries. Do not add a provider call to this path.

`GET /api/semantic-index` reports whether the index has a recorded model
identity and its page coverage, without disclosing that identity or requiring a
provider. `POST /api/semantic-index/rebuild` requires
`{ "confirm": "REBUILD SEMANTIC INDEX", "limit": 20 }`, resolves the explicitly
configured embedding provider, and processes 1-100 missing pages. Each vector is
committed only if its page stayed unchanged. Repeating the request resumes from
missing pages; semantic search remains unavailable and links remain empty until
coverage is complete. Completion rebuilds positive mutual cross-source
nearest-neighbour links.

### `POST /api/discoveries/generate`

An empty JSON object stages the current cross-source candidate frontier and
evaluates the next bounded chunk. The response contains `discoveries` plus
`coverage` with `generation`, eligible-page and candidate counts, evaluated and
proposed counts, remaining work, and completion state. Send the returned
`generation` in the next request to continue without rebuilding or repeating the
frontier:

```json
{ "generation": "<returned UUID>" }
```

Model omissions are checkpointed for the exact page content, model, prompt
version, sweep scope, seed set, and eligible-page snapshot. A resume token
cannot be reused for another scope or a changed wiki. Provider or validation
failure leaves the current chunk queued. A new empty request refreshes the
frontier and reuses unchanged decisions. Prompt source metadata is bounded, but
complete provenance remains part of candidate identity; highly consolidated
pages are not excluded merely because many sources contributed. No model
response becomes a wiki link until a person confirms its proposal.

### `POST /api/discoveries/batch`

Review an exact selection of 1-500 open synthesis proposals without a provider:

```json
{
  "action": "confirm",
  "ids": [17, 21, 24],
  "confirm": "CONFIRM 3 LINKS"
}
```

Use `"action": "reject"` with `"REJECT 3 PROPOSALS"` to reject the same
selection. IDs must be unique positive integers and every item must still be
pending or investigating. Confirmation also requires every proposal to retain an
unlinked pair and the exact page hashes seen by the proposing model. The server
preflights all selected pages, prepares the final Markdown for every affected
file, and pairs recoverable file replacement with one SQLite status transaction.
Confirmation stores type, explanation, significance, evidence page hashes, and
confirmation time in portable frontmatter while retaining a normal `links`
entry. Any invalid or stale item aborts the entire batch. The browser never
preselects proposals; filtering and selection only define the exact
user-confirmed batch.

`POST /api/ingest/undo` requires `{ "confirm": "UNDO" }`. Undo accepts only the
newest not-yet-undone history record and refuses any affected page whose current
hash differs from its recorded approved hash. Files are restored with rollback,
then `DB.undoIngest()` updates the catalog transactionally. Immutable sources
and archived after-images remain in the vault.

### `POST /api/ingest/file` (SSE)

Send `multipart/form-data` with exactly one `file` and an optional `title`.
Accepted formats are PDF, UTF-8 Markdown (`.md` or `.markdown`), and UTF-8 text
(`.txt`). The route applies a separate bounded upload limit and then uses the
same proposal-review SSE flow as pasted text. PDF text is extracted page by page
with the pinned Mozilla PDF.js package; no system `pdftotext` executable is
required. Password-protected and image-only PDFs are rejected, so run OCR before
uploading a scanned document.

### `POST /api/ingest/playlist` (SSE)

Request body: `{ "url": "<playlist ID or YouTube URL containing list=...>" }`

Same SSE stages, but with `distilling` events per video
(`{ title: "Video N/M" }`). Partial failures emit `warning`; total failure emits
`error` with code `PLAYLIST_INGEST_FAILED`.

### `GET /api/search`

Query parameters:

- `q` - search query (required)
- `mode` - `hybrid` (default), `semantic`, or `keyword`

Returns `{ results: [{ id, title, score, matchType }], query }`, ordered by
descending score. Semantic scores are cosine similarities; keyword scores are
negated SQLite FTS ranks. Higher means more relevant within that query, not a
confidence probability. Semantic mode returns `409 SEMANTIC_INDEX_INCOMPLETE`
until every current page has a compatible embedding. Rate limits retain their
structured `429 RATE_LIMITED` response.
