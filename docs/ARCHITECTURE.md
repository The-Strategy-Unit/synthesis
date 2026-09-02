# Architecture

Technical overview of Synthesis internals.

## Module map

```
main.ts                         # Single application entrypoint
├── src/app/                    # Composition, configuration, launch and trial mode
├── src/http/                   # HTTP transport and policy
│   ├── routes.ts               # Small authenticated capability dispatcher
│   ├── routes/                 # System, review, provider, wiki and ingest routes
│   ├── core.ts                 # Auth, limits, validation and safe responses
│   ├── ingest_support.ts       # SSE and bounded ingest request handling
│   └── wiki_support.ts         # Query and search transport helpers
├── src/ingest/                 # Extract, distil, stage, review and apply sources
├── src/wiki/                   # Markdown model, schema, graph, query, lint, discovery
├── src/vault/                  # Manifest, export, rebuild, history, undo, migration
├── src/provider/               # LLM/embedding transport, profiles and secrets
├── src/catalogue/              # Rebuildable SQLite catalogue
│   ├── db.ts                   # Connection, schema and transaction coordinator
│   ├── note_store.ts           # Page records and FTS content
│   ├── source_store.ts         # Sources and page provenance
│   ├── proposal_store.ts       # Ingest proposal review state
│   ├── discovery_store.ts      # Discovery review and candidate state
│   ├── search_store.ts         # Embeddings, links and keyword/semantic search
│   └── maintenance_store.ts    # Atomic rebuild and undo catalogue mutations
└── src/shared/                 # Small cross-capability helpers
```

Tests remain beside their capability as `*_test.ts`. The folders are ordinary ES
modules under one `deno.json`, not separately versioned workspace packages. `DB`
owns one SQLite connection and the `BEGIN IMMEDIATE` transaction boundary;
focused stores share that connection without weakening cross-store atomicity.

## Data flow

### Ingest pipeline

```
User submits URL/text or uploads one local PDF/Markdown/text file
  ↓
src/http/routes/ingest_routes.ts: POST /api/ingest (SSE stream)
  ↓
src/ingest/ingest.ts
  ├── YouTube: yt-dlp --write-auto-sub → VTT → parseVtt() → transcript text
  ├── Text: wrapped directly as transcript
  └── Local file: bounded multipart bytes → src/ingest/local_file.ts
        ├── UTF-8 Markdown/text: strict decode
        └── PDF: pinned PDF.js → `## PDF page N` text sections
  ↓
SHA-256 identity check (original bytes for uploads, transcript otherwise)
  → return an existing proposal or applied notes on duplicates
  ↓
src/ingest/distil.ts: distil()
  ├── splitTranscript() → chunks (maxChars=12000, overlap=500)
  ├── extractChunk() per chunk (parallel, extractModel, JSON mode)
  │     → substantial topical evidence candidates
  └── consolidateCandidates() (consolidateModel, single call)
        → a small set of coherent source-level wiki pages + summary
  ↓
Persist immutable extracted text + metadata + summary under sources/<sha256>/
  and preserve uploaded bytes as original.pdf/.md/.txt
  ↓
src/ingest/distil.ts: integrate()
  ├── FTS shortlists relevant existing notes
  ├── Compares against their titles and bounded contents
  └── Returns decision: new | merge | contradict (+ existing_id)
  ↓
Prepare and validate every proposed Markdown page without mutating the wiki
  → PDF pages must retain in-range source_pages through both model stages
  ↓
Persist one pending ingest proposal with new/merge/contradict changes
  ↓
Manual default: a human explicitly selects reviewed changes, edits body text if
needed, and approves or rejects them; an empty approval is invalid
Trusted batch: an exact confirmed source list automatically selects all changes
  ↓ approve or automatic apply
Revalidate target-page hashes → embed every change before mutation
  ↓
Write a durable history manifest and before-images
  ↓
Apply files, catalogue, FTS, embeddings, provenance, index, and log
  as one recoverable operation; restore files if the DB transaction fails
  ↓
Manual ingest: recompute the positive mutual-neighbour semantic graph after
apply only when every current page has a compatible embedding
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
  db.search.searchKeyword(query)
    → FTS5 MATCH on notes_fts → ranked by FTS rank

semantic mode:
  DB.embedText(query) → embedding
  db.search.searchSemantic(qEmb)
    → sqlite-vec MATCH + kNN → cosine distance → similarity = 1 - distance

Both return descending `[{ id, title, score, matchType }]` results. Semantic
scores are cosine similarities. Keyword scores negate SQLite FTS rank so that
higher consistently means more relevant; neither score is a probability.
```

The API default is hybrid. `SearchStore` has a combined `db.search.search()`
method that merges keyword + semantic results with matchType `"both"`. The
browser requests semantic search only while a provider is ready and the
model-bound semantic index is complete; otherwise it requests deterministic
keyword search. It refreshes readiness before each search, states the active
method, displays raw cosine similarity for semantic results, and displays
canonical result order for keyword matches. API clients can request hybrid
search explicitly. Keyword search, browsing, sources, the graph, deterministic
lint, export, rebuild, and undo do not resolve a provider and remain available
offline. Wiki queries seed context from FTS, optionally add semantic results,
and expand one explicit-link hop.

### Export and recovery

`GET /api/export` streams `vault.json`, `schema.md`, `notes/`, `sources/`, and
`history/` as POSIX tar. SQLite and provider credentials are excluded.

`POST /api/rebuild` validates the manifest/schema, source metadata and hashes,
compiler-managed pages, unique titles, exact wiki-link targets, and provenance
before any database mutation. It regenerates `index.md`, then atomically
replaces the SQLite source/note/provenance/FTS catalogue. Embeddings and
semantic links are empty after rebuild. A separately confirmed, provider-backed
`POST /api/semantic-index/rebuild` processes missing page embeddings in bounded
resumable batches and recreates links only after complete coverage. Proposals,
discovery candidate coverage, and discoveries are cleared because their
numeric-ID review state is not yet represented as durable vault files. The
browser repeats bounded 20-page requests until the whole wiki is covered or the
user asks it to stop after the current batch.

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
  → stream cancellation stops before the next source; resubmission reuses
    staged proposals and already applied source identities
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

Long ingest streams are cooperatively cancellable. Cancellation never interrupts
an atomic file/catalogue apply, and an in-flight download or provider call may
finish before the stream releases the ingest gate. Repeating the same playlist
or exact trusted list resumes from durable source identities and pending
proposals. Cross-source review checkpoints every completed candidate batch, so a
restarted sweep does not repeat unchanged model decisions.

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

The `file_path` values in `notes` and `sources` use forward-slash,
vault-relative paths. Catalogue stores resolve them against the directory that
contains `synthesis.db` before filesystem I/O. Opening a legacy catalogue
transactionally normalises recognised absolute `notes/` and `sources/` paths, so
a closed vault can be moved without retaining its previous host path. Server
shutdown closes the catalogue connection before process exit, leaving transient
WAL and shared-memory sidecars out of a clean portable vault.

### `embeddings` (sqlite-vec virtual table)

```sql
CREATE VIRTUAL TABLE embeddings USING vec0(
  note_id INTEGER PRIMARY KEY,
  vector FLOAT[768] distance_metric=cosine
);
```

Vector dimensions default to 768 (`SYNTHESIS_EMBED_DIMENSIONS`), matching the
native output width of `nomic-embed-text-v2-moe`.

`catalog_metadata.embedding_identity` binds current vectors to the normalised
embedding-provider URL, model, dimensions, and any model-specific input format.
A different identity atomically clears vectors and derived links. Legacy vectors
without identity are cleared during database migration rather than assumed
compatible.

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

This table stores positive mutual cross-source nearest neighbours:
`computeLinks()` retains a pair only when each page ranks the other within its
bounded candidate set. This rank-stability condition avoids manufacturing an
edge merely to fill `k`; zero and negative cosine pairs are excluded. Direction
is normalised to `min(id), max(id)` and deduplicated by the `UNIQUE` constraint.
Explicit links are read from canonical page Markdown and are not cached here;
when both types connect the same pages, the explicit relationship wins.

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
explanation, significance, evidence page/source IDs, exact evidence page hashes,
model metadata, and a guarded `pending|investigating → confirmed|rejected`
lifecycle. The model can only judge a supplied pair; it cannot invent page or
source IDs.

### `discovery_candidates`

Stores rebuildable progress for systematic cross-source review. A generation
contains the current lexical and embedding candidate frontier after excluding
shared provenance, existing explicit links, and still-current proposed pairs.
`discovery_generations` binds each resume token to its scope, seeds,
eligible-page snapshot, prompt version, and model. Each candidate is keyed by
the exact evidence-bearing page content hashes, model, and prompt version, and
moves from `queued` to either `reviewed` (no proposal) or `proposed`. Re-running
a sweep reuses unchanged decisions, while changed pages, models, or prompts
receive new candidate identities. Full page provenance remains in identity and
review records; only source metadata sent in one prompt is bounded, so mature
multi-source pages remain eligible. Failed model calls leave their batch queued.
The browser and trusted-batch workflow process bounded chunks until the
generation is complete, so provider interruption is resumable.

Candidate retrieval is a recall mechanism, not evidence. The model sees only the
exact supplied pair and its source metadata; every proposal remains pending
until human confirmation.

`consolidation_candidate` identifies pages that may cover the same durable
concept. Confirmation promotes the reviewed overlap into canonical Markdown as
an explicit wiki link, but does not merge or delete either page. Confirmed
proposal types also retain portable typed frontmatter with explanation,
significance, evidence page hashes, and confirmation time. Post-ingest page
merging needs a separate exact-Markdown, hash-guarded, recoverable mutation
workflow.

## Key algorithms

### Embedding and storage

`DB.embedText()` (static) calls the OpenAI-compatible `/embeddings` endpoint,
requests the configured dimensions, validates the returned width, and returns a
`number[]`. Callers identify text as a document or query. For the default Nomic
v2 model, the input layer applies its required `search_document:` or
`search_query:` retrieval instruction; other model inputs remain unchanged.
`embedAndStore()` wraps this: embeds `title + "\n" + body`, then calls
`upsertEmbedding()` which deletes any existing vector for that note_id and
inserts the new one.

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
suggestions, and short atomic wiki entries. The 768-dimensional default matches
the default model's native output. Changing dimensions still requires rebuilding
the vector index, so benchmark alternatives in a new vault first.

### Link computation

`db.search.computeLinksFor(noteIds, k)` performs a complete derived-graph
rebuild when at least one page changed. A changed embedding can enter or leave
another page's nearest-neighbour set, so a touched-page-only update would leave
stale or asymmetric results.

1. Validate the bounded neighbour count and clear the derived `links` rows.
2. For every embedded page, compare against every other embedded page with the
   sqlite-vec kNN query.
3. Exclude pages that share any source provenance, so pages from one source do
   not crowd out cross-source relationships.
4. Retain up to `k` positive neighbours for each page; zero and negative cosine
   pairs cannot become proximity links.
5. Keep a pair only when the ranking is mutual, then normalise direction,
   deduplicate the undirected set, and store similarity.

`buildWikiGraph()` then overlays authoritative explicit links parsed from files.
The browser initially keeps the strongest configured number of stored mutual
semantic neighbours around each page and uses similarity for force and distance.
This makes connected clusters, bridges, and hubs reproducible and potentially
informative. Distances between disconnected components, the axes, rotation, and
the overall silhouette carry no semantic meaning.

An active wiki search filters only the browser presentation. Search result IDs
become seed pages; the graph retains their direct reviewed and currently visible
semantic neighbours, then includes existing edges among that bounded node set.
It does not expand to second-hop pages or alter the stored graph. Clearing the
search restores the complete graph. A pinned node focus is also presentation
state: it keeps positions fixed, fades unrelated nodes and edges, and offers an
explicit transition to the page reader. Clearing the search clears the pin. The
maximised graph is the same live SVG and force simulation in a fixed viewport,
not a second graph instance. Explicitly choosing Connections maximises it and
fits the settled node bounds once; user zoom, pan, drag, or focus cancels the
pending automatic fit, while an explicit **Fit graph** action remains available.

Semantic links remain derived suggestions. Only a separately reviewed discovery
can promote a relationship into canonical Markdown.

### LLM pipeline stages

| Stage       | Model role         | Default model  | Temperature | Max tokens | JSON mode |
| ----------- | ------------------ | -------------- | ----------- | ---------- | --------- |
| Extract     | `extractModel`     | `qwen3.5:9b`   | 0           | 2000       | yes       |
| Consolidate | `consolidateModel` | `qwen3.5:122b` | 0.1         | 4000       | yes       |
| Integrate   | `integrateModel`   | `qwen3.5:122b` | 0.1         | 2000       | yes       |
| Rewrite     | `rewriteModel`     | `qwen3.5:122b` | -           | 2000       | no        |

All LLM calls go through `src/provider/llm.ts`, which constructs
OpenAI-compatible `/chat/completions` requests and validates provider envelopes.
Local Ollama receives an explicit `reasoning_effort: "none"`; providers that may
not support that value do not. Structured workflows retry one validation failure
at temperature 0, but never retry transport, HTTP, timeout, or truncation
failures. The current `schema.md` is bounded and included in every
model-authored knowledge workflow.

## Migration from legacy Elixir DB

`scripts/migrate.ts` wraps `src/vault/migrate.ts`, which:

1. Opens the old SQLite DB (read-only, with sqlite-vec extension)
2. Reads `zettels` joined with `episodes`
3. For each zettel: splits `insight` into title/body, writes a `.md` file with
   frontmatter, inserts into `notes` + `notes_fts`
4. Writes per-source `meta.json` files to `~/Synthesis/sources/`
5. Migrates `zettel_links` → `links` (deduplicating bidirectional pairs)
6. Migrates `embeddings` (vec0 → vec0, preserving vectors)

## Packaging

`scripts/compile.ts` creates self-extracting standalone executables with Deno's
experimental QuickJS backend. It first bundles and minifies the application
while leaving `sqlite-vec` and the credential-store addon as target-native npm
packages. It embeds exactly `index.html`, `style.css`, and the generated browser
bundle instead of the source, tests, docs, or local demo material. Native addons
require the self-extracting layout. Because the pinned PDF.js Node build assumes
a rendering canvas and sibling worker, compilation replaces exactly its two
canvas loaders with a non-rendering text-extraction facade and embeds a minified
worker at the expected path. The patch fails closed if that upstream shape
changes.

`deno task compile` targets the current host. The target-specific tasks emit
Linux x86_64, macOS ARM64, or Windows x86_64 executables; `deno task build`
emits all three. An 80 MiB ceiling catches accidental dependency-tree growth.
YouTube support remains external through `yt-dlp` beside the executable or on
`PATH`.

`src/app/compiled_entry.ts` opens the normal vault by default. `--trial` creates
a disposable loopback-only vault, writes seven ordinary cited Markdown pages
from four curated blood-pressure trial extracts, rebuilds the
provider-independent catalogue, and opens the browser. Its guided story follows
an apparent population-dependent disagreement into a direct trial-result
conflict and a scoped, provenance-preserving resolution. The trial makes no
provider call and uses the same vault format and application routes as ordinary
operation.

Run `deno task test:compiled <executable>` on the artefact's target OS. The
smoke check covers the UI, native SQLite and `sqlite-vec` startup, PDF text
extraction, and the pre-populated trial vault. Cross-platform CI runs that gate
on Linux x86_64, macOS ARM64, and Windows x86_64.

The same workflow is the release boundary. Pull requests and manual dispatches
retain read-only repository permissions and upload CI artefacts. A pushed `v*`
tag adds a dependent release job with narrowly scoped `contents: write`
permission. It verifies the tag against `deno.json`, waits for all native smoke
tests, packages each executable with the licence, generates SHA-256 checksums,
and creates the GitHub Release. Published assets are treated as immutable;
reruns accept an exact existing asset set and fail closed on any mismatch.
