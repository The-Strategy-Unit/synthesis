# Synthesis ⚗️

Synthesis compiles scattered source material into a persistent, linked, local
wiki. It follows
[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
knowledge is integrated once and compounds over time instead of being
reconstructed from raw chunks for every question.

Each ingestion archives the immutable source, extracts durable pages, and
integrates them into the existing wiki. New evidence can create a page, merge
into one, or record a contradiction. The result is ordinary Markdown backed by
explicit provenance, semantic search, and a query interface with citations.

**Local-first by design:** the authoritative vault is ordinary Markdown,
immutable sources, and portable history kept on your device; SQLite is a
rebuildable index. Core reading, provenance, keyword search, export, rebuild,
and undo work offline, and source content leaves the device only when you
explicitly configure a remote model provider.

The current `main` line is a single-user MVP for local use and controlled
private beta evaluation. It is stateful software: one process owns one
writeable, file-backed vault, while SQLite search and vector state remain
rebuildable.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - runtime, persistence, and compiler flow
- [Developer guide](docs/DEVELOPERS.md) - setup, configuration, testing, and API

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
- Streamed portable vault export, provider-free catalogue rebuild, resumable
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

Running from source requires [Deno 2 or later](https://deno.com/). YouTube
ingestion optionally requires [yt-dlp](https://github.com/yt-dlp/yt-dlp).
Building the experimental QuickJS executables requires Deno 2.9.5.

### 15-second trial

Start a prebuilt executable with a disposable, provider-free evidence vault:

```bash
./synthesis-linux-x86_64 --trial
# macOS: ./synthesis-macos-aarch64 --trial
# Windows PowerShell: .\synthesis-windows-x86_64.exe --trial
```

From a warmed source checkout, use `deno task trial`. Unless `SYNTHESIS_PORT` is
set, Synthesis chooses a free loopback port, opens the browser, and loads seven
linked pages derived from curated extracts of the ACCORD BP, SPRINT, STEP, and
BPROAD randomised trials. Open **How the evidence conflict evolved** to follow
the evidence as an apparent disagreement becomes a direct conflict, then open
**Blood-pressure targets across trials** to see the scoped resolution. Inspect
**Sources**, then search for `stroke hypotension hyperkalaemia`. No model is
needed for this path. The extracts link to the papers but are not the full
papers, and the disposable vault is an evidence-synthesis demonstration, not
clinical guidance. Export before stopping if you want to keep changes.

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

### Model sizing

The quality-first default keeps high-volume extraction on `qwen3.5:9b` and
assigns harder editorial judgements to `qwen3.5:122b`:

```bash
SYNTHESIS_EXTRACT_MODEL=qwen3.5:9b \
SYNTHESIS_CONSOLIDATE_MODEL=qwen3.5:122b \
SYNTHESIS_INTEGRATE_MODEL=qwen3.5:122b \
SYNTHESIS_REWRITE_MODEL=qwen3.5:122b \
deno task app
```

The larger model handles source consolidation, `new|merge|contradict` decisions,
page-body rewriting, and cross-source discovery; the configured embedding model
remains responsible for retrieval and candidate similarity. Synthesis reports a
missing 122B model instead of silently substituting a smaller model. On hosts
where 122B is not practical, explicitly override the three decision roles with a
smaller evaluated model. Saved Provider profiles take precedence over
environment defaults and currently use one selected chat model for every role.

This profile trades speed for capacity. It should be evaluated on representative
sources and does not remove evidence checking or human review. In particular,
trusting a source does not guarantee that an automatically generated summary or
relationship preserves every qualification in that source. Provider calls have a
ten-minute default timeout so slower local 122B decisions can complete.

### Recompile an archived vault

`scripts/recompile_vault.ts` builds a new wiki from another vault's immutable
source archives without copying its existing pages, catalogue, or history. It
hash-checks every archived source, preserves original ingest order when history
is available, stages and explicitly selects each source's changes, and computes
the semantic graph after the complete model-bound index is ready. The source
vault is never mutated, and the destination must be empty unless `--resume` is
used after an interrupted run.

For a local Ollama recompilation from 66 archived sources:

```bash
deno run --allow-env \
  --allow-net=127.0.0.1:11434,localhost:11434 \
  --allow-read=. --allow-write=new-vault --allow-ffi \
  scripts/recompile_vault.ts \
  --source old-vault --destination new-vault \
  --extract-model qwen3.5:27b --editor-model gpt-oss:120b \
  --embedding-model nomic-embed-text-v2-moe:latest \
  --confirm "RECOMPILE 66 SOURCES"
```

The exact confirmation is count-bound. The tool checks that all three advertised
model roles are available before creating the destination. Re-run the same
command with `--resume` to reuse already accepted sources and pending proposals.

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

### Standalone executables

Build one target, or all three release targets:

```bash
deno task compile:linux    # dist/synthesis-linux-x86_64
deno task compile:macos    # dist/synthesis-macos-aarch64
deno task compile:windows  # dist/synthesis-windows-x86_64.exe
deno task build            # all three
```

Each self-extracting executable uses Deno's experimental QuickJS engine and
contains only the minified application bundle, three runtime web assets, PDF
text extraction, SQLite, and the target's `sqlite-vec` and credential-store
native addons. It does not require Deno on the target computer. The build fails
if an executable exceeds 80 MiB, guarding against accidentally embedding the
complete npm dependency tree or local documentation and demos.

Run the executable normally to use the default vault, or add `--trial` for the
disposable guided trial. Add `--no-open` for a headless launch. YouTube ingest
additionally requires `yt-dlp` (`yt-dlp.exe` on Windows) beside the executable
or on `PATH`.

The executables are unsigned and macOS builds are not notarised. QuickJS is
smaller and starts with less overhead than V8, but it is experimental, slower
for compute-heavy JavaScript, and does not receive the same security updates as
V8. Treat these builds as controlled demonstration/private-beta artefacts, test
them on their target operating system, and do not use them to process untrusted
material. See
[Deno compile](https://docs.deno.com/runtime/reference/cli/compile/).

Releases are automated from version tags. Update the `version` in `deno.json`,
commit and push that change, then create and push the matching annotated tag:

```bash
git tag -a v0.1.0 -m "Synthesis v0.1.0"
git push origin v0.1.0
```

The cross-platform workflow rejects a tag that does not equal
`v<deno.json version>`. After all three target-native compiled smoke tests pass,
it publishes a GitHub Release with Linux and macOS tarballs, a Windows zip, the
licence in each archive, generated release notes, and `SHA256SUMS`.
`workflow_dispatch` builds downloadable workflow artefacts but does not publish
a release.

## Create, open, export, and restore a vault

A vault is an ordinary directory containing the authoritative Markdown, sources,
schema, and history. One running Synthesis process owns one writeable vault.

Create or open the default vault at `~/Synthesis`:

```bash
deno task app
```

Create a vault at a chosen location - or reopen it later with the same command:

```bash
SYNTHESIS_VAULT="$PWD/my-vault" deno task app
```

To make a portable backup, choose **Vault tools → Export vault**. The downloaded
tar archive contains the authoritative vault and excludes the rebuildable SQLite
catalogue and provider credentials.

To restore it, extract the archive into a new empty directory and open that
directory as the vault:

```bash
mkdir restored-vault
tar -xf synthesis-vault-YYYY-MM-DD.tar -C restored-vault
SYNTHESIS_VAULT="$PWD/restored-vault" deno task app
```

Then choose **Vault tools → Rebuild catalogue** to restore keyword search and
explicit links. Choose **Build semantic index** - or **Resume semantic index**
until complete - to restore model-bound semantic search and proximity
suggestions. Provider settings and credentials remain separate and must be
configured on the restored installation.

## Demo workflow

1. Configure a provider, if not using the default Ollama configuration, and use
   **Diagnose active provider** to verify that its required models are present.
2. Choose a representative PDF, Markdown, or text file - or paste source text -
   then choose **Ingest**. Image-only PDFs need OCR before ingestion.
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
10. Demonstrate recovery with **Undo ingest**, or use **Rebuild catalogue** to
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
apply failure. **Stop safely** cancels the stream cooperatively; the current
download, model call, or atomic source apply may finish first. Re-submit the
same exact list to resume: pending proposals are reused, sources already applied
to the current vault are detected by content identity and skipped, and completed
cross-source candidate decisions are checkpointed. Ordinary playlists use the
same stop-and-resubmit behaviour but leave every source proposal for manual
review. Each automatically applied source retains its proposal and writes a
history manifest with `reviewMode: automatic` and the shared batch ID. This is
an efficiency option, not a quality check; curate the source list and audit the
resulting wiki.

## Compilation pipeline

1. **Archive** - preserve the raw source or original uploaded file, extracted
   page-aware text, metadata, hash, and source summary.
2. **Extract** - identify substantial topical evidence candidates from bounded
   chunks without turning each isolated claim into a page.
3. **Consolidate** - compose the candidates into a small set of coherent,
   source-level wiki pages.
4. **Integrate** - classify each page as `new`, `merge`, or `contradict` against
   the existing wiki.
5. **Rewrite** - update affected pages while preserving links and provenance.
6. **Index** - update SQLite FTS, embeddings, graph links, `index.md`, and
   `log.md`.
7. **Synthesise across sources** - shortlist cross-source page pairs across the
   vault without excluding highly consolidated pages, then propose grounded
   relationships or possible consolidations for review.
8. **Query** - answer from compiled pages, cite them, and optionally compile a
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
and provenance before replacing the derived SQLite catalogue. Rebuild restores
keyword search, typed reviewed relationships, and explicit wiki links
immediately. **Build semantic index** sends bounded page batches to the
explicitly configured embedding provider; completed pages are checkpointed so
the operation can resume until semantic search and mutual proximity links are
complete. Rebuild also clears pending proposals, discovery candidate coverage,
and discovery-review state because those queues are not yet durable vault
artefacts.

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
| `SYNTHESIS_CONSOLIDATE_MODEL`       | `qwen3.5:122b`                   | Source synthesis             |
| `SYNTHESIS_INTEGRATE_MODEL`         | `qwen3.5:122b`                   | Integration decisions        |
| `SYNTHESIS_REWRITE_MODEL`           | `qwen3.5:122b`                   | Page rewriting               |
| `SYNTHESIS_EMBED_MODEL`             | `nomic-embed-text-v2-moe:latest` | Embeddings                   |
| `SYNTHESIS_EMBED_DIMENSIONS`        | `768`                            | Required embedding width     |
| `SYNTHESIS_LINK_K`                  | `8`                              | Mutual-neighbour breadth     |
| `SYNTHESIS_GRAPH_NEIGHBORS`         | `3`                              | Initially visible neighbours |
| `SYNTHESIS_MAX_UPLOAD_BYTES`        | `26214400`                       | Multipart upload limit       |
| `SYNTHESIS_MAX_PDF_PAGES`           | `500`                            | PDF page limit               |
| `SYNTHESIS_PDF_PARSE_TIMEOUT_MS`    | `30000`                          | PDF extraction timeout       |
| `SYNTHESIS_MODEL_TIMEOUT_MS`        | `600000`                         | Provider request timeout     |
| `SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS` | `100`                            | Automatic video limit        |

See [docs/DEVELOPERS.md](docs/DEVELOPERS.md) for the complete configuration
reference.

The default `nomic-embed-text-v2-moe:latest` model emits 768-dimensional
vectors. Synthesis requests and validates that width and applies the model's
required document/query retrieval prefixes automatically.

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
| `/api/rebuild`                 | POST    | Rebuild derived catalogue state from files   |
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
deno task trial
deno task compile
deno task build
```

`test:e2e` is automated and provider-independent. It starts a temporary local
server and verifies the HTTP workflow and served UI assets. `test:browser`
launches Chromium against another temporary vault and exercises search
relevance, graph maximisation, fit, keyboard restoration, and restore in the
real DOM. Windows CI uses its preinstalled Edge; pass an explicit Chromium
executable locally when it is not on `PATH`. Both tests clean up their temporary
vaults. The `compile` tasks create one standalone executable; `build` creates
the Linux x64, macOS ARM64, and Windows x64 QuickJS executables. Target-OS CI
smokes each executable's UI, native SQLite startup, PDF extraction, and trial
vault.

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
src/vault_rebuild.ts           strict provider-free catalogue reconstruction
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

## Licence

See `LICENSE`.
