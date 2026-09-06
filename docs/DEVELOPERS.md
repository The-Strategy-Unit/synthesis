# Developer guide

Synthesis 0.2.5 is a frozen MIT-licensed MVP. This repository is not accepting
further product development or providing support. Fork it before extending it.

## Setup

Requirements:

- Deno 2+; CI uses Deno 2.9.5.
- Ollama or another explicitly selected OpenAI-compatible provider.
- `yt-dlp` only for YouTube ingestion.

```bash
deno task setup        # check Ollama, yt-dlp, models, and vault directory
deno task app          # open ~/Synthesis at http://localhost:8000
deno task dev          # watch mode
deno task trial        # disposable provider-free demo
```

Use `.env.example` as the configuration reference. Never commit credentials or
real vault data.

## Repository map

| Path                  | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `main.ts`, `src/app/` | Composition and startup                   |
| `src/http/`           | HTTP/SSE policy and routes                |
| `src/ingest/`         | Extraction, proposal, review, apply       |
| `src/wiki/`           | Markdown, links, lint, query, discovery   |
| `src/vault/`          | Export, rebuild, history, undo, migration |
| `src/catalogue/`      | SQLite, FTS5, sqlite-vec                  |
| `src/provider/`       | Provider transport, profiles, secrets     |
| `web/`                | Browser ES modules, HTML, CSS             |
| `scripts/`            | Setup, tests, build, smoke, migration     |

Tests are collocated as `*_test.ts` or `*_test.js`. Do not edit generated
`web/app.bundle.js` or `dist/`.

## Quality gates

```bash
deno fmt --check <changed-files>
deno lint
deno task check
deno task test:unit
deno task test:integration
deno task test:e2e
deno task test:browser
```

Backend, persistence, provider, ingest, or API changes require integration
tests. UI and route changes require E2E. Packaging changes require compilation
and `deno task test:compiled <executable>` on each target OS. Automated tests
use temporary vaults and mocked providers; they must not need credentials,
Ollama, `yt-dlp`, or internet access.

`deno task lint` is a mutating convenience command. Use the non-mutating
formatter and linter commands above for review.

## Configuration

All variables are validated in `src/app/config.ts`; `.env.example` contains the
complete list and defaults.

### Runtime and access

| Variable                            | Default              | Purpose                          |
| ----------------------------------- | -------------------- | -------------------------------- |
| `SYNTHESIS_VAULT`                   | `~/Synthesis`        | Authoritative vault              |
| `SYNTHESIS_APP_DATA`                | Platform config dir  | Provider profiles and secrets    |
| `SYNTHESIS_HOST` / `SYNTHESIS_PORT` | `127.0.0.1` / `8000` | Listener                         |
| `SYNTHESIS_OPEN_BROWSER`            | `true`               | Launch browser                   |
| `SYNTHESIS_PUBLIC_ORIGIN`           | unset                | Required protected origin        |
| `SYNTHESIS_TRUST_PROXY_AUTH`        | `false`              | Trust Cloudflare identity header |
| `SYNTHESIS_ALLOWED_EMAILS`          | empty                | Viewers                          |
| `SYNTHESIS_INGESTER_EMAILS`         | empty                | Mutation identities              |

Never enable proxy auth unless clients can reach the app only through that
trusted proxy.

### Providers

| Variable                                               | Default                          |
| ------------------------------------------------------ | -------------------------------- |
| `SYNTHESIS_API_BASE`                                   | `http://localhost:11434/v1`      |
| `SYNTHESIS_API_KEY`                                    | `ollama`                         |
| `SYNTHESIS_EMBED_API_BASE` / `SYNTHESIS_EMBED_API_KEY` | Inherit chat provider            |
| `SYNTHESIS_EXTRACT_MODEL`                              | `qwen3.6:27b`                    |
| `SYNTHESIS_CONSOLIDATE_MODEL`                          | `qwen3.6:27b`                    |
| `SYNTHESIS_INTEGRATE_MODEL`                            | `qwen3.6:27b`                    |
| `SYNTHESIS_REWRITE_MODEL`                              | `qwen3.6:27b`                    |
| `SYNTHESIS_EMBED_MODEL`                                | `nomic-embed-text-v2-moe:latest` |
| `SYNTHESIS_EMBED_DIMENSIONS`                           | `768`                            |
| `SYNTHESIS_REASONING_EFFORT`                           | `none`                           |

Temperature and token limits are independently configurable for extract,
consolidate, integrate, rewrite, and query roles; see `.env.example`. Changing
embedding identity invalidates vectors and derived links. A different vector
width requires a new database.

### Bounds

| Area    | Variables and defaults                                             |
| ------- | ------------------------------------------------------------------ |
| HTTP    | body 1 MiB; upload 25 MiB; pasted text 250,000 characters          |
| Source  | transcript 500,000 characters; subtitles 10 MiB                    |
| PDF     | 500 pages; 30-second parse timeout                                 |
| Models  | 10-minute request timeout; 12,000-character extraction input       |
| Queue   | 4 waiting; 5 jobs/user/day; 20 jobs/day globally                   |
| YouTube | 2-minute `yt-dlp`; playlist 10; manual queue 20; trusted batch 100 |
| Search  | 500-character query; 20 results; 5 semantic searches/minute        |
| Graph   | retain 8 semantic neighbours; display 3 initially                  |

Every bound can be overridden within the clamps defined in `config.ts`.

## Permissions and trust

`scripts/start.ts` gives the child runtime network access for runtime-selected
providers, FFI for sqlite-vec, scoped vault/app-data/temp file access,
restricted environment access, and permission to run `yt-dlp`.

Provider bases must be HTTPS URLs ending in `/v1`, except loopback HTTP. API
keys belong in the OS keyring or environment. Model output, uploads, JSON, URLs,
paths, Markdown, citations, IDs, and provider envelopes are validated at their
boundaries.

## API index

There is no generated OpenAPI document. `src/http/routes.ts` and its five route
modules are authoritative.

| Area        | Routes                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System      | `GET /api/config`, `/status`, `/schema`, `/export`, `/semantic-index`; `PUT /api/schema`; `POST /api/rebuild`, `/semantic-index/rebuild`                              |
| Provider    | `GET /api/provider`, `/provider/readiness`; `POST /api/provider`, `/provider/diagnose`                                                                                |
| Wiki        | `GET /api/notes`, `/notes/:id`, `/sources`, `/sources/:id`, `/search`, `/graph`, `/lint`; `POST /api/lint/analyze`, `/query`, `/query/save`                           |
| Ingest      | `POST /api/ingest`, `/ingest/file`, `/ingest/playlist`, `/ingest/queue`, `/ingest/batch`, `/ingest/undo`                                                              |
| Proposals   | `GET /api/proposals`, `/api/proposals/:id`; `POST /api/proposals/:id/approve`, `/api/proposals/:id/reject`, `/api/proposals/:id/reprocess`                            |
| Discoveries | `GET /api/discoveries`, `/api/discoveries/:id`; `POST /api/discoveries/generate`, `/api/discoveries/batch`, `/api/discoveries/:id/investigate`, `/confirm`, `/reject` |

Mutation bodies require JSON except `/api/ingest/file`, which requires multipart
form data. Ingest and approval use SSE. Errors expose only a safe `error`,
`code`, and `requestId`; diagnostics stay server-side.

Important exact confirmations:

| Operation              | Confirmation                   |
| ---------------------- | ------------------------------ |
| Catalogue rebuild      | `REBUILD`                      |
| Semantic index rebuild | `REBUILD SEMANTIC INDEX`       |
| Undo newest ingest     | `UNDO`                         |
| Trusted batch          | `AUTO APPLY N TRUSTED SOURCES` |
| Confirm discoveries    | `CONFIRM N LINKS`              |
| Reject discoveries     | `REJECT N PROPOSALS`           |

Manual proposal approval requires a non-empty array of exact reviewed change
indexes; `{}` is invalid. Trusted batches are the only flow that selects all
staged wiki changes automatically. Discovery proposals always remain pending for
human review.

Search accepts `mode=keyword|semantic|hybrid`; hybrid is the API default.
Semantic mode returns `409 SEMANTIC_INDEX_INCOMPLETE` until the current index is
complete. Scores rank results within a query and are not probabilities.

## Packaging

```bash
deno task compile             # current host
deno task compile:linux
deno task compile:macos
deno task compile:windows
deno task build               # all targets
deno task test:compiled <executable>
```

Compiled executables use the experimental QuickJS backend and target-native
SQLite/keyring packages. Browser assets are bundled; the HACA vault is placed
beside the executable in release archives. The 80 MiB executable ceiling guards
against accidental dependency or private-data inclusion.

The GitHub workflow runs on pull requests, manual dispatch, and `v*` tags. Tag
releases require `v<deno.json version>`, native smoke tests on Linux, macOS, and
Windows, and publish immutable platform archives plus `SHA256SUMS`.

Version 0.2.5 is the final release of this repository:

```bash
git tag -a v0.2.5 -m "Synthesis v0.2.5"
git push origin v0.2.5
```

After verifying the release assets, archive the repository. Further releases
belong in a fork.

## Troubleshooting

- **Provider unavailable:** open **Provider**, run diagnostics, and verify the
  explicit endpoint and models. Offline wiki functions remain available.
- **Semantic index incomplete:** use **Build semantic index**; it resumes in
  bounded batches.
- **PDF has no text:** OCR it before upload.
- **YouTube fails:** install `yt-dlp` beside the executable or on `PATH`.
- **Moved or restored vault:** rebuild the catalogue, then rebuild embeddings if
  semantic search is needed.
- **Interrupted ingest:** reopen the pending proposal or resubmit the same
  source; immutable source identity prevents duplicate application.

## Frozen boundaries

Do not treat the MVP as multi-tenant, serverless, clinical, or production-ready.
It has no supported deployment, update, telemetry, incident-response, or
security-maintenance service. Preserve the local-first trust boundary, exact
review, portable files, and recoverable mutation design in any fork.
