# Architecture

Technical overview of Synthesis internals.

## Module map

```
main.ts                     # Composition root and loopback HTTP server
├── src/config.ts           # All config + env overrides, path helpers
├── src/db.ts               # SQLite + sqlite-vec + FTS5: CRUD, embeddings, links, search
├── src/llm.ts              # Shared chat transport, validation, and bounded structured recovery
├── src/distil.ts           # Multi-stage LLM pipeline: extract → consolidate → integrate → rewrite
├── src/ingest.ts           # YouTube transcript fetching (yt-dlp), text wrapping, playlist expansion
├── src/local_file.ts       # Bounded PDF/Markdown/text parsing and validation
├── src/ingest_proposal.ts  # Persisted, validated review-proposal format
├── src/trusted_batch.ts    # Exact-list automatic-ingest validation and confirmation
├── src/ingest_history.ts   # Durable before-images and accepted-apply manifests
├── src/ingest_undo.ts      # Hash-guarded last-ingest recovery
├── src/orchestrate.ts      # Source staging, approval, rollback, and note integration
├── src/vault_manifest.ts   # Stable vault identity and format version
├── src/vault_export.ts     # Streaming portable tar export
├── src/vault_rebuild.ts    # Provider-free catalog reconstruction
├── src/wiki_schema.ts      # Editable vault policy supplied to model workflows
├── src/wiki_graph.ts       # Explicit-link-first graph and related-page views
├── src/discovery.ts        # Cross-source synthesis candidates and review lifecycle
├── src/query.ts            # Context-bounded answers and reviewed write-back
├── src/wiki_lint.ts        # Provider-free checks and optional AI analysis
├── src/routes.ts           # Authenticated API, limits, queue, SSE, static files
├── src/migrate.ts          # Legacy Elixir DB → Deno migration (zettels → notes)
├── src/rebuild_links.ts    # Standalone link recomputation utility
└── src/utils.ts            # slugify()
```

Embedding, linking, and search logic all live in `src/db.ts` as methods on the
`DB` class.

## Data flow

### Ingest pipeline

```
User submits URL/text or uploads one local PDF/Markdown/text file
  ↓
src/routes.ts: POST /api/ingest (SSE stream)
  ↓
src/ingest.ts
  ├── YouTube: yt-dlp --write-auto-sub → VTT → parseVtt() → transcript text
  ├── Text: wrapped directly as transcript
  └── Local file: bounded multipart bytes → src/local_file.ts
        ├── UTF-8 Markdown/text: strict decode
        └── PDF: pinned PDF.js → `## PDF page N` text sections
  ↓
SHA-256 identity check (original bytes for uploads, transcript otherwise)
  → return an existing proposal or applied notes on duplicates
  ↓
src/distil.ts: distil()
  ├── splitTranscript() → chunks (maxChars=12000, overlap=500)
  ├── extractChunk() per chunk (parallel, extractModel, JSON mode)
  │     → candidate atomic notes
  └── consolidateCandidates() (consolidateModel, single call)
        → deduplicated notes + summary
  ↓
Persist immutable extracted text + metadata + summary under sources/<sha256>/
  and preserve uploaded bytes as original.pdf/.md/.txt
  ↓
src/distil.ts: integrate()
  ├── FTS shortlists relevant existing notes
  ├── Compares against their titles and bounded contents
  └── Returns decision: new | merge | contradict (+ existing_id)
  ↓
Prepare and validate every proposed Markdown page without mutating the wiki
  → PDF pages must retain in-range source_pages through both model stages
  ↓
Persist one pending ingest proposal with new/merge/contradict changes
  ↓
Manual default: a human reviews the exact Markdown and approves or rejects it
Trusted batch: an exact confirmed source list automatically selects all changes
  ↓ approve or automatic apply
Revalidate target-page hashes → embed every change before mutation
  ↓
Write a durable history manifest and before-images
  ↓
Apply files, catalogue, FTS, embeddings, provenance, index, and log
  as one recoverable operation; restore files if the DB transaction fails
  ↓
Manual ingest: recompute the rank-bounded semantic graph after apply
Trusted batch: defer one graph rebuild until the final source has applied
  ↓
Manual ingest: compare touched pages with cross-source candidates across the vault
Trusted batch: compare the whole vault once after the final source
  → model reviews only preselected pairs
  → relationship and consolidation candidates enter Synthesis review
  → failure here does not roll back accepted knowledge
```

Rejected proposals never mutate wiki pages. Immutable source archives remain
available for audit and retry. Production routes use `stageSingleSource()`;
`processSingleSource()` remains only for lower-level and golden tests. PDF
parsing is in-process and performs no network requests. It is bounded by upload
bytes, extracted characters, page count, and elapsed time. Encrypted and
image-only PDFs are rejected rather than producing ungrounded knowledge.
Automatic trusted batches do not bypass staging, Markdown validation, stale-hash
checks, embedding, history, or recoverable apply; they bypass only the repeated
human selection step after an explicit count-specific batch confirmation. They
never auto-confirm cross-source synthesis proposals.

Cross-source proposals may be reviewed individually or as an explicitly selected
batch of at most 500 IDs. Nothing is preselected. Batch confirmation requires
the exact phrase `CONFIRM N LINKS`; rejection requires `REJECT N PROPOSALS`. The
compiler preflights every selected discovery and its current page files before
mutation. Confirmed links are prepared in memory, written with original-file
rollback, and paired with one SQLite status transaction; any stale or invalid
item aborts the whole batch. Batch rejection changes only discovery review state
in one transaction.

### Search

```
GET /api/search?q=...&mode=semantic|keyword

keyword mode:
  db.searchKeyword(query)
    → FTS5 MATCH on notes_fts → ranked by FTS rank

semantic mode (default):
  DB.embedText(query) → embedding
  db.searchSemantic(qEmb)
    → sqlite-vec MATCH + kNN → cosine distance → similarity = 1 - distance

Both return: [{ id, title, score, matchType }]
```

`db.ts` also has a combined `db.search()` method that merges keyword + semantic
results with matchType `"both"`, but `routes.ts` uses the requested single mode.
Keyword search, browsing, sources, the graph, deterministic lint, export,
rebuild, and undo do not resolve a provider and remain available offline. Wiki
queries seed context from FTS, optionally add semantic results, and expand one
explicit-link hop.

### Export and recovery

`GET /api/export` streams `vault.json`, `schema.md`, `notes/`, `sources/`, and
`history/` as POSIX tar. SQLite and provider credentials are excluded.

`POST /api/rebuild` validates the manifest/schema, source metadata and hashes,
compiler-managed pages, unique titles, exact wiki-link targets, and provenance
before any database mutation. It regenerates `index.md`, then atomically
replaces the SQLite source/note/provenance/FTS catalog. Embeddings and semantic
links are empty after rebuild. Proposals, discovery candidate coverage, and
discoveries are cleared because their numeric-ID review state is not yet
represented as durable vault files.

`POST /api/ingest/undo` selects the newest not-yet-undone history manifest. All
current affected pages must match their recorded approved hashes. The operation
archives after-images, restores before-images, removes newly created pages from
the live wiki, writes `undo.json`, and transactionally updates SQLite. On a
pre-commit failure it restores the live files. Immutable source archives remain.

### Playlist ingest

```
POST /api/ingest/playlist
  → getPlaylistVideos(url) via yt-dlp --flat-playlist
  → iterates each video URL through the same staging path
  → creates a separate review proposal per source
  → SSE streams per-video progress
```

### Trusted video batch

```
POST /api/ingest/batch
  → validates a bounded, unique, exact list of YouTube video URLs
  → requires AUTO APPLY N TRUSTED SOURCES for that exact count
  → resolves one provider configuration for the whole batch
  → sequentially stages and automatically applies every validated change
  → stops on the first pre-commit failure; already applied sources are skipped
  → records reviewMode=automatic and one shared batch UUID in ingest history
```

This mode accepts exact video URLs rather than expanding a playlist. It applies
`new`, `merge`, and `contradict` alike and makes no claim that trusted input
produces correct model output. The ordinary single-source and playlist routes
continue to require review.

## Database schema

### `notes` table

```sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  source_url TEXT,
  source_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### `embeddings` (sqlite-vec virtual table)

```sql
CREATE VIRTUAL TABLE embeddings USING vec0(
  note_id INTEGER PRIMARY KEY,
  vector FLOAT[768] distance_metric=cosine
);
```

Vector dimensions default to 768 (`SYNTHESIS_EMBED_DIMENSIONS`).

### `links` table

```sql
CREATE TABLE links (
  source_note_id INTEGER NOT NULL,
  target_note_id INTEGER NOT NULL,
  similarity REAL NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  UNIQUE(source_note_id, target_note_id)
);
```

This table stores the union of each embedded page's strongest cross-source
semantic neighbours. `computeLinks()` normalises to `min(id), max(id)` ordering
and deduplicates via the `UNIQUE` constraint. It stores similarity even when its
absolute value would be low under another embedding model; rank within the
current vault determines inclusion. Explicit links are read from canonical page
Markdown and are not cached here; when both types connect the same pages, the
explicit relationship wins.

### `notes_fts` (FTS5 virtual table)

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content);
```

FTS rows are kept in sync manually: `indexNote()` deletes then re-inserts. Rowid
matches `notes.id`.

### `sources` and `note_sources`

`sources` records immutable inputs by unique SHA-256 content hash, canonical raw
file path, source metadata, and generated source summary. `note_sources` is a
many-to-many provenance table recording whether a source created, merged into,
or contradicted a note. Both raw source files and Markdown source references
survive downstream integration failures; SQLite search/vector/link state is
rebuildable derived data.

Approved ingest history is stored under `history/` with source/proposal
identity, per-page before/after hashes, before-images, retained after-images
when undone, review mode, an automatic batch ID where applicable, and an undo
receipt. Legacy manifests without a review mode are read as manual. This
filesystem state is authoritative for last-ingest recovery; SQLite proposal and
discovery queues remain derived MVP state.

### `ingest_proposals`

Stores the exact validated Markdown proposed for one immutable source, with a
guarded `pending → approved|rejected` lifecycle. Changes to existing pages carry
their base content hashes so approval refuses stale rewrites.

### `discoveries`

Stores deduplicated cross-source synthesis proposals with relationship type,
explanation, significance, evidence page/source IDs, model metadata, and a
guarded `pending|investigating → confirmed|rejected` lifecycle. The model can
only judge a supplied pair; it cannot invent page or source IDs.

### `discovery_candidates`

Stores rebuildable progress for systematic cross-source review. A generation
contains the current lexical and embedding candidate frontier after excluding
shared provenance, existing explicit links, and previously proposed pairs. Each
candidate is keyed by the exact evidence-bearing page content hashes, model, and
prompt version, and moves from `queued` to either `reviewed` (no proposal) or
`proposed`. Re-running a sweep reuses unchanged decisions, while changed pages,
models, or prompts receive new candidate identities. Failed model calls leave
their batch queued. The browser and trusted-batch workflow process bounded
chunks until the generation is complete, so provider interruption is resumable.

Candidate retrieval is a recall mechanism, not evidence. The model sees only the
exact supplied pair and its source metadata; every proposal remains pending
until human confirmation.

`consolidation_candidate` identifies pages that may cover the same durable
concept. Confirmation promotes the reviewed overlap into canonical Markdown as
an explicit wiki link, but does not merge or delete either page. Other confirmed
proposal types likewise become explicit links. Post-ingest page merging needs a
separate exact-Markdown, hash-guarded, recoverable mutation workflow.

## Key algorithms

### Embedding and storage

`DB.embedText()` (static) calls the OpenAI-compatible `/embeddings` endpoint and
returns a `number[]`. `embedAndStore()` wraps this: embeds
`title + "\n" + body`, then calls `upsertEmbedding()` which deletes any existing
vector for that note_id and inserts the new one.

### Future multi-resolution retrieval (not implemented)

The MVP stores one embedding per wiki page. A possible later retrieval design
would add bounded passage embeddings without replacing page embeddings or
authoritative wiki links. It should not embed every sentence independently:
isolated sentences can lose meaning carried by headings, neighbouring sentences,
pronouns, citations, lists, and tables. Sentence-level indexing would also
multiply storage and local-model work: one 768-dimensional float32 vector
occupies approximately 3 KiB before index overhead.

The preferred design preserves the existing page embedding and selectively adds
passage embeddings for longer pages:

- Pages of at most four sentences or approximately 800 characters retain only
  their page embedding.
- Longer pages are divided along semantic boundaries into passages of roughly
  two to four sentences or 80–200 words, with one sentence of overlap.
- Each passage is prefixed with its page title and section heading before
  embedding so that it remains meaningful outside its original position.
- Keyword, page-vector, and passage-vector results are combined and deduplicated
  by page. The matched passage supplies the search snippet, while its
  surrounding page supplies answer context.
- Explicit wiki links remain authoritative. Embedding similarity produces
  retrieval and connection candidates rather than durable knowledge.

Passage vectors should live in a separate table keyed by passage ID, with the
note ID, ordinal or source location, text, and content hash retained alongside
them. Page embeddings must remain available for broad discovery, graph
suggestions, and short atomic wiki entries. The 768-dimensional default was
selected after retrieval and resource benchmarking. Changing dimensions still
requires rebuilding the vector index, so benchmark alternatives in a new vault
first.

### Link computation

`db.computeLinksFor(noteIds, k)` performs a complete derived-graph rebuild when
at least one page changed. A changed embedding can enter or leave another page's
nearest-neighbour set, so a touched-page-only update would leave stale or
asymmetric results.

1. Validate the bounded neighbour count and clear the derived `links` rows.
2. For every embedded page, compare against every other embedded page with the
   sqlite-vec kNN query.
3. Exclude pages that share any source provenance, so pages from one source do
   not crowd out cross-source relationships.
4. Retain the strongest `k` remaining neighbours for each page. There is no
   absolute cosine threshold because score distributions vary by model and
   corpus.
5. Normalise direction, deduplicate the undirected union, and store similarity.

`buildWikiGraph()` overlays authoritative explicit links parsed from files. The
browser uses similarity to set link force and distance, so connected clusters,
bridges, and hubs are reproducible and potentially informative. Distances
between disconnected components, axes, rotation, and overall silhouette carry no
semantic meaning. Semantic links remain derived suggestions; only reviewed
discoveries become canonical Markdown links.

### LLM pipeline stages

| Stage       | Model role         | Default model | Temperature | Max tokens | JSON mode |
| ----------- | ------------------ | ------------- | ----------- | ---------- | --------- |
| Extract     | `extractModel`     | `qwen3.5:9b`  | 0           | 2000       | yes       |
| Consolidate | `consolidateModel` | `qwen3.5:9b`  | 0.1         | 4000       | yes       |
| Integrate   | `integrateModel`   | `qwen3.5:9b`  | 0.1         | 2000       | yes       |
| Rewrite     | `rewriteModel`     | `qwen3.5:9b`  | -           | 2000       | no        |

All LLM calls go through `src/llm.ts`, which constructs OpenAI-compatible
`/chat/completions` requests and validates provider envelopes. Local Ollama
receives an explicit `reasoning_effort: "none"`; providers that may not support
that value do not. Structured workflows retry one validation failure at
temperature 0, but never retry transport, HTTP, timeout, or truncation failures.
The current `schema.md` is bounded and included in every model-authored
knowledge workflow.

## Migration from legacy Elixir DB

`scripts/migrate.ts` wraps `src/migrate.ts`, which:

1. Opens the old SQLite DB (read-only, with sqlite-vec extension)
2. Reads `zettels` joined with `episodes`
3. For each zettel: splits `insight` into title/body, writes a `.md` file with
   frontmatter, inserts into `notes` + `notes_fts`
4. Writes per-source `meta.json` files to `~/Synthesis/sources/`
5. Migrates `zettel_links` → `links` (deduplicating bidirectional pairs)
6. Migrates `embeddings` (vec0 → vec0, preserving vectors)

## Packaging

`scripts/build.ts` creates platform-specific source distributions under `dist/`.
They require Deno on the target machine and include:

- The application source, locked dependencies, docs, and browser assets
- A platform-appropriate `yt-dlp` binary
- A setup script (`setup.sh` or `setup.ps1`) that checks Ollama and pulls models
- Template substitution for model names from `config.build`

Platforms: Linux x86_64, macOS ARM64, Windows x86_64.

`scripts/compile.ts` separately creates self-extracting standalone executables
with Deno's experimental QuickJS backend. `deno task compile` targets the
current host; `deno task compile:windows` cross-compiles Windows x86_64. The web
assets, PDF support, SQLite, `sqlite-vec`, and target OS credential-store addon
are embedded. Run `deno task test:compiled <executable>` on the artifact's
target OS.
