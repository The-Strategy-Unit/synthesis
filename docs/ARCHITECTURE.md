# Architecture

Technical overview of Synthesis internals.

## Module map

```
main.ts                     # Composition root and loopback HTTP server
├── src/config.ts           # All config + env overrides, path helpers
├── src/db.ts               # SQLite + sqlite-vec + FTS5: CRUD, embeddings, links, search
├── src/distil.ts           # Multi-stage LLM pipeline: extract → consolidate → integrate → rewrite
├── src/ingest.ts           # YouTube transcript fetching (yt-dlp), text wrapping, playlist expansion
├── src/orchestrate.ts      # Source persistence and transactional note integration
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
User submits URL or text
  ↓
main.ts: POST /api/ingest (SSE stream)
  ↓
src/ingest.ts
  ├── YouTube: yt-dlp --write-auto-sub → VTT → parseVtt() → transcript text
  └── Text: wrapped directly as transcript
  ↓
SHA-256 identity check → return existing linked notes without AI on duplicates
  ↓
src/distil.ts: distil()
  ├── splitTranscript() → chunks (maxChars=12000, overlap=500)
  ├── extractChunk() per chunk (parallel, extractModel, JSON mode)
  │     → candidate atomic notes
  └── consolidateCandidates() (consolidateModel, single call)
        → deduplicated notes + summary
  ↓
Persist immutable raw source + metadata + summary under sources/<sha256>/
  ↓
src/distil.ts: integrate()
  ├── FTS shortlists relevant existing notes
  ├── Compares against their titles and bounded contents
  └── Returns decision: new | merge | contradict (+ existing_id)
  ↓
For each note:
  ├── new: exclusive .md creation → transactional DB/index/vector/provenance
  ├── merge: rewrite + embed → atomic file replace → transactional derived state
  └── contradict: same as merge, preserving explicit source references
  ↓
db.computeLinksFor(touchedIds, threshold)
  → removes stale touched links and recomputes them transactionally
  ↓
SSE sends "done" with note list
```

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
results with matchType `"both"`, but `main.ts` currently uses single-mode search
based on the `mode` query parameter.

### Playlist ingest

```
POST /api/ingest/playlist
  → getPlaylistVideos(url) via yt-dlp --flat-playlist
  → iterates each video URL through processSingleSource()
  → computes links once at the end
  → SSE streams per-video progress
```

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
  vector FLOAT[4096] distance_metric=cosine
);
```

Vector dimensions default to 4096 (`SYNTHESIS_EMBED_DIMENSIONS`).

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

Links are stored bidirectionally - `computeLinks()` normalises to
`min(id), max(id)` ordering and deduplicates via the `UNIQUE` constraint.

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

## Key algorithms

### Embedding and storage

`DB.embedText()` (static) calls the OpenAI-compatible `/embeddings` endpoint and
returns a `number[]`. `embedAndStore()` wraps this: embeds
`title + "\n" + body`, then calls `upsertEmbedding()` which deletes any existing
vector for that note_id and inserts the new one.

### Link computation

`db.computeLinks(threshold, k)`:

1. Fetch all notes
2. For each note, get its embedding via `getEmbedding()`
3. Find k nearest neighbors via `findNearest()` (sqlite-vec kNN query)
4. Filter by similarity ≥ threshold
5. Normalise direction: `source = min(id), target = max(id)`
6. Deduplicate via a `seen` set + DB `UNIQUE` constraint
7. Upsert into `links` table

This is O(n × k) queries, recomputed after every ingest.

### LLM pipeline stages

| Stage       | Model role         | Default model | Temperature | Max tokens | JSON mode |
| ----------- | ------------------ | ------------- | ----------- | ---------- | --------- |
| Extract     | `extractModel`     | `qwen3.5:9b`  | 0.2         | 2000       | yes       |
| Consolidate | `consolidateModel` | `qwen3.6:27b` | 0.1         | 4000       | yes       |
| Integrate   | `integrateModel`   | `qwen3.5:9b`  | 0.1         | 2000       | yes       |
| Rewrite     | `rewriteModel`     | `qwen3.6:27b` | -           | 2000       | no        |

All LLM calls go through a shared `chat()` helper in `distil.ts` that constructs
OpenAI-compatible `/chat/completions` requests. The `reasoning_effort` field is
sent only when set to something other than `none`.

## Migration from legacy Elixir DB

`scripts/migrate.ts` wraps `src/migrate.ts`, which:

1. Opens the old SQLite DB (read-only, with sqlite-vec extension)
2. Reads `zettels` joined with `episodes`
3. For each zettel: splits `insight` into title/body, writes a `.md` file with
   frontmatter, inserts into `notes` + `notes_fts`
4. Writes per-source `meta.json` files to `~/Synthesis/sources/`
5. Migrates `zettel_links` → `links` (deduplicating bidirectional pairs)
6. Migrates `embeddings` (vec0 → vec0, preserving vectors)

## Build system

`scripts/build.ts` creates platform-specific distribution bundles under `dist/`.
Each bundle includes:

- A platform-appropriate `yt-dlp` binary
- A setup script (`setup.sh` or `setup.ps1`) that checks Ollama and pulls models
- Template substitution for model names from `config.build`

Platforms: Linux x86_64, macOS ARM64, Windows x86_64.
