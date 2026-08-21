# Synthesis

Synthesis compiles scattered source material into a persistent, linked, local
wiki. It follows
[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
knowledge is integrated once and compounds over time instead of being
reconstructed from raw chunks for every question.

Each ingestion archives the immutable source, extracts durable pages, and
integrates them into the existing wiki. New evidence can create a page, merge
into one, or record a contradiction. The result is ordinary Markdown backed by
explicit provenance, semantic search, and a query interface with citations.

## Project provenance

Synthesis is an independently maintained continuation and substantial rewrite of
the original MIT-licensed project developed during an initial public-sector
exploration. It is not an official product of, or maintained by, the originating
organisation.

The current `main` line is a single-user MVP for local use and controlled
private beta evaluation. It is stateful software: one process owns one writable,
file-backed vault, while SQLite search and vector state remain rebuildable.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — runtime, persistence, and compiler flow
- [Developer guide](docs/DEVELOPERS.md) — setup, configuration, testing, and API
- [Private beta deployment](docs/DEPLOYMENT.md) — protected stateful hosting,
  backups, and rollout

## MVP capabilities

- Typed `concept`, `entity`, and `synthesis` pages with explicit
  `[[wiki links]]`
- Immutable raw-source archive and many-to-many page provenance
- Local PDF, Markdown, and text upload; PDF evidence retains page locations and
  the original file
- Editable `schema.md` defining the vault's purpose and compilation conventions
- Staged new/merge/contradict proposals with human approval by default
- Explicitly confirmed trusted-video batches that sequentially apply every
  validated change with portable automatic-review audit records
- Deterministic wiki index and machine-readable change log
- Keyword and model-bound semantic search with mutual cross-source proximity
  suggestions and reviewed wiki links overlaid
- Resumable cross-source candidate coverage with reviewed proposals for
  relationships and possible page consolidation
- Wiki-grounded answers with cited pages and reviewed synthesis write-back
- Deterministic structural/provenance lint plus optional AI health analysis
- Source review showing which pages each source created or changed
- OpenAI-compatible local or remote providers with keys in the OS credential
  store
- Provider-independent browsing, source review, graph navigation, keyword
  search, and deterministic health checks
- Streamed portable vault export, provider-free catalog rebuild, resumable
  provider-backed semantic rebuild, and hash-guarded last-ingest undo

Synthesis is intended for research and knowledge-management workflows. It is not
validated clinical decision-support software. Do not use it for patient care or
regulated/identifiable data without the appropriate validation, governance,
security, and human review.

Automatic trusted-source mode deliberately removes proposal-by-proposal review.
Use it only for an exact, curated list whose model-generated output you accept
responsibility for checking later; source trust does not establish output
accuracy.

## Quick start

Prerequisites: [Deno 2 or later](https://deno.com/), and optionally
[yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube ingestion. Building the
experimental QuickJS executables requires Deno 2.9.5 or later.

### Local Ollama

Install and start [Ollama](https://ollama.com/), then run:

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup
deno task app
```

The setup task checks Ollama and reports any models that still need to be
pulled. The start task creates the local vault if necessary and opens
`http://localhost:8000`.

### Remote OpenAI-compatible provider

Skip the Ollama-specific setup and start directly:

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task app
```

Open **Provider**, enter the chat and embedding endpoints, models, and API keys,
then choose **Test and save**. Endpoints must end in `/v1`. Synthesis tests both
connections before saving; profile metadata goes to the app-data directory and
keys go to the operating system credential store.

### Windows executable

From Linux, macOS, or Windows, compile an unsigned Windows x64 executable with
the experimental QuickJS backend:

```bash
deno task compile:windows
```

The artifact is `dist/synthesis-windows-x86_64.exe`. It embeds the web UI, PDF
support, SQLite, the Windows `sqlite-vec` extension, and Windows
credential-store support. Copy it to the Windows computer, start Ollama, run the
executable, and open `http://127.0.0.1:8000`. The default vault is
`%USERPROFILE%\Synthesis`.

YouTube ingestion additionally requires `yt-dlp.exe` either beside
`synthesis-windows-x86_64.exe` or on `PATH`. The executable is not code-signed;
sign it before distributing it beyond a controlled internal demo. QuickJS and
cross-compilation are provided by
[Deno compile](https://docs.deno.com/runtime/reference/cli/compile/).

## Demo workflow

1. Configure a provider, if not using the default Ollama configuration, and use
   **Diagnose active provider** to verify that its required models are present.
2. Choose a representative PDF, Markdown, or text file—or paste source text—then
   choose **Ingest**. Image-only PDFs need OCR before ingestion.
3. Open **Review**, inspect the proposed page changes and provenance, then
   approve them to mutate the wiki.
4. Ingest and approve a second source that supports, extends, or contradicts the
   first.
5. Open **Synthesis review**, run or resume the cross-source sweep, and confirm
   only grounded, useful proposals. Confirmation records a typed reviewed
   relationship alongside its ordinary explicit wiki link.
6. Open **Sources** to inspect source summaries and derived-page provenance.
7. Open **Ask wiki**, ask a cross-source question, review its cited pages, and
   optionally save the answer as a new synthesis page.
8. Open **Wiki health** to inspect broken links, missing provenance,
   contradictions, orphan pages, and optional AI findings.
9. Choose **Export** to download the authoritative Markdown, sources, schema,
   manifest, and revision history as a portable tar archive.
10. Demonstrate recovery with **Undo ingest**, or use **Rebuild catalog** to
    reconstruct provider-independent state, followed by **Build semantic index**
    to restore model-bound search and proximity suggestions.

The notes list, explicit-link graph, and keyword search update as the wiki
changes. A page change makes the semantic index incomplete; semantic search and
proximity suggestions remain unavailable until **Build semantic index** resumes
and finishes. With an AI provider and a complete compatible index, the search
box ranks pages by cosine similarity and shows that raw score. Otherwise it uses
full-text relevance order. A failed semantic request offers an explicit keyword
retry rather than silently relabelling results. The result list states the
active method and puts the strongest match first. Semantic similarity is not a
confidence probability.

With complete semantic coverage, the graph compares every embedded page with the
whole wiki. It retains positive cross-source neighbours only when each page
ranks the other within its bounded nearest-neighbour set. Similarity shapes
connected clusters, bridges, and hubs; distance between disconnected groups,
axes, and rotation have no meaning. A semantic proximity edge is a suggestion to
investigate, not confirmed knowledge. Reviewed links from page Markdown are
overlaid separately. The breadth control chooses how many stored proximity
suggestions are visible; it is not a similarity or confidence score.

While a search is active, matching pages seed a one-hop contextual subgraph:
their visible neighbours and the connections among those pages remain, while the
unrelated remainder is hidden until the search is cleared. Direct matches are
shown as white nodes. Selecting a graph node pins its visible neighbourhood
without moving or removing the surrounding graph; the user can then open its
page or clear the focus. Clearing the search also clears this focus and restores
the complete graph. Choosing **Connections** expands the same live graph to the
browser viewport, lets its force layout settle, and then fits every positioned
node once. Manual zooming, panning, dragging, or focusing cancels that automatic
fit; **Fit graph** remains available at any time. **Restore graph** or Escape
returns to the workspace without discarding search, breadth, or pinned focus.

### Automatic trusted-video batches

Under **Add source → More options**, choose **Trusted videos · automatic
apply**, paste one exact YouTube video ID or URL per line, read the warning, and
type the displayed count-specific confirmation. Synthesis processes the list
sequentially so each source is compared with the wiki produced by earlier
sources. Every validated `new`, `merge`, and `contradict` change is applied
without opening Review. After the final source, a resumable whole-vault sweep
builds a lexical and embedding candidate frontier across sources, evaluates it
in bounded model batches, and records both proposals and reviewed omissions so
an interrupted run continues instead of repeating work. Supported relationships
or consolidation candidates appear in **Synthesis review** and are never
confirmed automatically.

The batch stops on the first download, provider, validation, stale-proposal, or
apply failure. Keep the page open while it runs. Re-submit the same exact list
to resume: sources already applied to the current vault are detected by content
identity and skipped. Each applied source retains its proposal and writes a
history manifest with `reviewMode: automatic` and the shared batch ID. This is
an efficiency option, not a quality check; curate the source list and audit the
resulting wiki.

## Compilation pipeline

1. **Archive** — preserve the raw source or original uploaded file, extracted
   page-aware text, metadata, hash, and source summary.
2. **Extract** — identify durable concepts, entities, findings, procedures, and
   cautions from bounded chunks.
3. **Consolidate** — deduplicate candidate pages within the source.
4. **Integrate** — classify each page as `new`, `merge`, or `contradict` against
   the existing wiki.
5. **Rewrite** — update affected pages while preserving links and provenance.
6. **Index** — update SQLite FTS, embeddings, graph links, `index.md`, and
   `log.md`.
7. **Synthesize across sources** — shortlist cross-source page pairs across the
   vault without excluding highly consolidated pages, then propose grounded
   relationships or possible consolidations for review.
8. **Query** — answer from compiled pages, cite them, and optionally compile a
   reviewed answer back into the wiki.

Manual ingest runs the cross-source pass around newly accepted pages. Trusted
batches defer it until the complete batch has been applied, avoiding a partial
scan after every video. A confirmed relationship becomes an explicit wiki link
and portable typed relationship metadata. Confirming a consolidation candidate
records its reviewed overlap; it does not yet merge or delete either page.

Open synthesis proposals can also be filtered and selected for an exact batch
decision. Nothing is selected automatically. Confirming a batch requires typing
`CONFIRM N LINKS`; rejecting one requires `REJECT N PROPOSALS`. The server
revalidates every selected proposal before changing anything, limits one batch
to 500 proposals, and applies confirmation as one recoverable operation. A
stale, missing, already reviewed, or already linked item stops the whole batch
instead of partially accepting it. Confirmation revalidates the exact evidence
page hashes and stores relationship type, explanation, significance, evidence
versions, and review time in page frontmatter. Model confidence remains
informational, not evidence.

## Storage

```text
~/Synthesis/
├── vault.json          # stable vault identity and format version
├── schema.md           # editable vault purpose and compilation policy
├── notes/
│   ├── index.md       # deterministic typed-page index
│   ├── log.md         # append-only logical change history
│   └── *.md           # compiled wiki pages
├── sources/           # immutable originals, extracted text, metadata, summaries
├── history/           # accepted-ingest before/after revisions and undo receipts
└── synthesis.db       # rebuildable catalogue, FTS, embeddings, and graph cache
```

Override the vault root with `SYNTHESIS_VAULT`. Provider profile metadata is
stored separately under the platform app-data directory; API keys are not stored
in the vault or profile file.

### Export and recovery

**Export** streams a tar archive containing `vault.json`, `schema.md`, `notes/`,
`sources/`, and `history/`. It deliberately excludes SQLite and provider
credentials. **Rebuild** strictly validates source hashes, wiki pages, links,
and provenance before replacing the derived SQLite catalog. Rebuild restores
keyword search, typed reviewed relationships, and explicit wiki links
immediately. **Build semantic index** sends bounded page batches to the
explicitly configured embedding provider; completed pages are checkpointed so
the operation can resume until semantic search and mutual proximity links are
complete. Rebuild also clears pending proposals, discovery candidate coverage,
and discovery-review state because those queues are not yet durable vault
artifacts.

**Undo ingest** applies only to the newest accepted, not-yet-undone ingest. It
refuses to overwrite a page changed since approval, retains immutable sources,
archives the removed after-version in `history/`, restores prior page revisions,
and clears affected semantic state. Semantic search stays unavailable until the
index is complete again. Export before material recovery operations.

## Configuration

Configuration is defined in `src/config.ts` and can be overridden with
environment variables. Common settings are:

| Variable                            | Default                          | Purpose                      |
| ----------------------------------- | -------------------------------- | ---------------------------- |
| `SYNTHESIS_VAULT`                   | `~/Synthesis`                    | Vault root                   |
| `SYNTHESIS_PORT`                    | `8000`                           | HTTP port                    |
| `SYNTHESIS_API_BASE`                | `http://localhost:11434/v1`      | Default chat API             |
| `SYNTHESIS_EXTRACT_MODEL`           | `qwen3.5:9b`                     | Chunk extraction             |
| `SYNTHESIS_CONSOLIDATE_MODEL`       | `qwen3.5:9b`                     | Source synthesis             |
| `SYNTHESIS_INTEGRATE_MODEL`         | `qwen3.5:9b`                     | Integration decisions        |
| `SYNTHESIS_REWRITE_MODEL`           | `qwen3.5:9b`                     | Page rewriting               |
| `SYNTHESIS_EMBED_MODEL`             | `nomic-embed-text-v2-moe:latest` | Embeddings                   |
| `SYNTHESIS_EMBED_DIMENSIONS`        | `768`                            | Required embedding width     |
| `SYNTHESIS_LINK_K`                  | `8`                              | Mutual-neighbour breadth     |
| `SYNTHESIS_GRAPH_NEIGHBORS`         | `3`                              | Initially visible neighbours |
| `SYNTHESIS_MAX_UPLOAD_BYTES`        | `26214400`                       | Multipart upload limit       |
| `SYNTHESIS_MAX_PDF_PAGES`           | `500`                            | PDF page limit               |
| `SYNTHESIS_PDF_PARSE_TIMEOUT_MS`    | `30000`                          | PDF extraction timeout       |
| `SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS` | `100`                            | Automatic video limit        |

See [docs/DEVELOPERS.md](docs/DEVELOPERS.md) for the complete configuration
reference.

## API

| Endpoint                       | Method  | Description                                  |
| ------------------------------ | ------- | -------------------------------------------- |
| `/api/status`                  | GET     | Minimal server health                        |
| `/api/config`                  | GET     | Non-secret UI configuration                  |
| `/api/provider`                | GET     | Redacted provider status                     |
| `/api/provider`                | POST    | Test and save provider configuration         |
| `/api/provider/readiness`      | GET     | Active-provider readiness without secrets    |
| `/api/provider/diagnose`       | POST    | Check active endpoints and required models   |
| `/api/schema`                  | GET/PUT | Read or update the vault schema              |
| `/api/export`                  | GET     | Stream the portable authoritative vault      |
| `/api/rebuild`                 | POST    | Rebuild derived catalog state from files     |
| `/api/semantic-index`          | GET     | Inspect semantic index coverage              |
| `/api/semantic-index/rebuild`  | POST    | Build or resume bounded semantic state       |
| `/api/notes`                   | GET     | List wiki pages                              |
| `/api/notes/:id`               | GET     | Page content and related pages               |
| `/api/sources`                 | GET     | List source provenance                       |
| `/api/sources/:id`             | GET     | Source summary and derived pages             |
| `/api/search?q=&mode=`         | GET     | Keyword or semantic search                   |
| `/api/graph`                   | GET     | Wiki relationship graph                      |
| `/api/query`                   | POST    | Answer from compiled pages with citations    |
| `/api/query/save`              | POST    | Save a reviewed cited synthesis              |
| `/api/lint`                    | GET     | Deterministic wiki health report             |
| `/api/lint/analyze`            | POST    | Optional provider-assisted health report     |
| `/api/ingest`                  | POST    | Stage URL or text changes with SSE progress  |
| `/api/ingest/batch`            | POST    | Confirm and auto-apply trusted video sources |
| `/api/ingest/file`             | POST    | Stage a bounded local file upload            |
| `/api/ingest/undo`             | POST    | Undo the newest unchanged accepted ingest    |
| `/api/ingest/playlist`         | POST    | Stage videos from a bounded YouTube playlist |
| `/api/proposals`               | GET     | List staged ingestion proposals              |
| `/api/proposals/:id`           | GET     | Inspect a proposed wiki change               |
| `/api/proposals/:id/approve`   | POST    | Apply an explicit reviewed change selection  |
| `/api/proposals/:id/reject`    | POST    | Reject a proposal                            |
| `/api/discoveries`             | GET     | List cross-source synthesis proposals        |
| `/api/discoveries/batch`       | POST    | Confirm or reject an exact selected batch    |
| `/api/discoveries/generate`    | POST    | Run or resume a bounded synthesis sweep      |
| `/api/discoveries/:id`         | GET     | Inspect one synthesis proposal               |
| `/api/discoveries/:id/:action` | POST    | Investigate, confirm, or reject              |

## Development

```bash
deno task dev
deno lint
deno task check
deno task test:unit
deno task test:integration
deno task test:e2e
deno task test:browser -- /path/to/chromium
deno task compile
deno task compile:windows
deno task build
```

`test:e2e` is automated and provider-independent. It starts a temporary local
server and verifies the HTTP workflow and served UI assets. `test:browser`
launches Chromium against another temporary vault and exercises search
relevance, graph maximisation, fit, keyboard restoration, and restore in the
real DOM. Windows CI uses its preinstalled Edge; pass an explicit Chromium
executable locally when it is not on `PATH`. Both tests clean up their temporary
vaults. The `build` task creates Deno source distributions with
platform-specific `yt-dlp`; the `compile` tasks create standalone
self-extracting QuickJS executables.

### Manual local-provider acceptance

The following is not the automated E2E suite. It checks the real provider and
source-review workflow against a clean, isolated vault.

On Linux or macOS, start an isolated Synthesis instance in one terminal:

```bash
SYNTHESIS_OPEN_BROWSER=false \
SYNTHESIS_PORT=8787 \
SYNTHESIS_VAULT="$PWD/output.rebuild" \
SYNTHESIS_APP_DATA="$PWD/output.rebuild-app-data" \
SYNTHESIS_PER_USER_DAILY_JOBS=1000 \
SYNTHESIS_GLOBAL_DAILY_JOBS=1000 \
deno task start
```

On Windows PowerShell:

```powershell
$root = (Get-Location).Path
$env:SYNTHESIS_OPEN_BROWSER = "false"
$env:SYNTHESIS_PORT = "8787"
$env:SYNTHESIS_VAULT = Join-Path $root "output.rebuild"
$env:SYNTHESIS_APP_DATA = Join-Path $root "output.rebuild-app-data"
$env:SYNTHESIS_PER_USER_DAILY_JOBS = "1000"
$env:SYNTHESIS_GLOBAL_DAILY_JOBS = "1000"
deno task start
```

Verify Ollama through the isolated instance:

```bash
curl -sS http://127.0.0.1:8787/api/provider/readiness
```

The response must contain `"ready":true`. Open `http://127.0.0.1:8787`, add one
representative source, inspect every proposed change and its evidence in Review,
then apply the reviewed changes. This validates the real Ollama connection
against newly ingested evidence.

Key modules:

```text
src/wiki.ts                    typed wiki model and Markdown compiler
src/orchestrate.ts             incremental source-to-wiki compilation
src/wiki_store.ts              index, log, and cited synthesis persistence
src/query.ts                   grounded cited wiki answers
src/wiki_lint.ts               deterministic and AI-assisted wiki health
src/vault_export.ts            portable authoritative tar streaming
src/vault_rebuild.ts           strict provider-free catalog reconstruction
src/ingest_history.ts          accepted-ingest revision history
src/ingest_undo.ts             hash-guarded last-ingest recovery
src/provider_*.ts              provider validation, runtime, and persistence
src/db.ts                      SQLite, provenance, FTS, embeddings, and links
src/routes.ts                  HTTP API and access controls
web/                           browser UI
```

## Privacy and deployment

With Ollama, model processing remains local. With a remote provider, relevant
source and wiki text is sent to that provider, so its data handling and
retention terms apply. Synthesis does not send API keys to browser responses.
Browsing pages and sources, following the graph, keyword search, deterministic
health checks, export, rebuild, and undo continue to work when no inference
provider is available. Ingestion, semantic-index building, AI-assisted analysis,
query answers, and discovery generation require Ollama or a configured remote
provider; semantic search additionally requires complete compatible index
coverage.

For network deployment, authentication, quotas, backups, and recovery guidance,
see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Do not expose the server directly
to the internet. The current SQLite/FFI, subprocess, OS-keychain,
writable-filesystem, and long-lived-SSE design is not directly deployable to a
serverless runtime such as Deno Deploy.

## License

See `LICENSE`.
