# Architecture Deep Dive

This document provides detailed technical information about Synthesis internals.

## Component Overview

```
main.ts
├── src/config.ts      # Environment configuration and defaults
├── src/db.ts          # SQLite + sqlite-vec for embeddings, FTS5 for keyword search
├── src/ingest.ts      # YouTube transcript fetching via yt-dlp
├── src/distil.ts      # LLM-based insight extraction (chunking, JSON parsing)
├── src/embed.ts       # Vector embeddings & semantic link computation
├── src/search.ts      # Hybrid keyword + semantic search
├── src/migrate.ts     # Legacy Elixir → Deno migration
└── src/rebuild_links.ts  # Manual link recomputation utility
```

## Data Flow

### Ingestion Pipeline

```
1. User provides YouTube URL or text
   ↓
2. ingest.ts
   ├── YouTube: Calls yt-dlp → downloads transcript (SRT/VTT)
   └── Text: Wraps in transcript format
   ↓
3. distil.ts
   ├── Chunks transcript (default: 12000 chars)
   ├── Calls LLM with SYSTEM_PROMPT
   └── Parses JSON response → array of notes
   ↓
4. embed.ts
   ├── Generates vector embeddings per note
   ├── Stores in sqlite-vec (embeddings table)
   └── Auto-links to existing notes (threshold: 0.75)
   ↓
5. db.ts
   ├── Saves note to SQLite (notes table)
   ├── Indexes in FTS5 (notes_fts) for keyword search
   └── Writes markdown file to disk
```

### Search Pipeline

```
1. User submits query
   ↓
2. search.ts
   ├── Vectorizes query (same embedding model)
   ├── sqlite-vec → semantic matches (top K by cosine similarity)
   ├── FTS5 → keyword matches
   └── Merges results via reciprocal rank fusion
   ↓
3. Returns ranked results with matchType metadata
```

## Database Schema

### Notes Table

```sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT CHECK(source_type IN ('youtube', 'text')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notes_source ON notes(source_url);
CREATE INDEX idx_notes_created ON notes(created_at);
```

### Embeddings (sqlite-vec Virtual Table)

```sql
-- sqlite-vec creates this automatically
CREATE VIRTUAL TABLE embeddings USING vec0(
  note_id INTEGER PRIMARY KEY,
  vector FLOAT[4096]  -- Cosine distance metric
);
```

### Links Table

```sql
CREATE TABLE links (
  source_note_id INTEGER NOT NULL,
  target_note_id INTEGER NOT NULL,
  similarity REAL NOT NULL CHECK(similarity >= 0 AND similarity <= 1),
  PRIMARY KEY (source_note_id, target_note_id),
  FOREIGN KEY (source_note_id) REFERENCES notes(id),
  FOREIGN KEY (target_note_id) REFERENCES notes(id)
);

CREATE INDEX idx_links_source ON links(source_note_id);
CREATE INDEX idx_links_target ON links(target_note_id);
```

### FTS5 Index

```sql
-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  content,
  content=notes,
  content_rowid=id
);
```

## Key Algorithms

### Auto-linking

After creating each new note, Synthesis computes similarity to existing notes:

```typescript
1. Generate embedding for new note
2. Query sqlite-vec: SELECT note_id, distance FROM embeddings WHERE distance < 0.25
   (similarity threshold 0.75 = distance threshold 0.25 for cosine)
3. For each match above threshold:
   INSERT INTO links (source_note_id, target_note_id, similarity)
```

### Semantic Search

Hybrid search combines keyword and semantic results:

```typescript
1. Keyword search (FTS5):
   SELECT note_id, rank FROM notes_fts WHERE notes_fts MATCH 'query'
   
2. Semantic search (sqlite-vec):
   SELECT note_id, 1 - distance as score 
   FROM embeddings 
   WHERE vector = query_embedding 
   LIMIT 50

3. Reciprocal Rank Fusion:
   score = ∑(1 / (rank + k))   // k = 60 (default RRF constant)
   
4. Sort by combined score, return top 20
```

## Configuration Deep Dive

### Environment Variables

Full list with defaults:

```bash
# Core paths
SYNTHESIS_VAULT=~/.Synthesis                    # Root directory
SYNTHESIS_PORT=8000                             # HTTP port

# Ollama connection
SYNTHESIS_API_BASE=http://localhost:11434/v1   # API endpoint
SYNTHESIS_API_KEY=ollama                        # API key

# Models
SYNTHESIS_LLM_MODEL=qwen3.6:27b                 # Distillation model
SYNTHESIS_EMBED_MODEL=qwen3-embedding:8b        # Embedding model

# Processing
SYNTHESIS_MAX_CHARS=12000                       # Chunk size
SYNTHESIS_LINK_THRESHOLD=0.75                   # Auto-link threshold
SYNTHESIS_SUBTITLES_LANG=en                     # Transcript language
```

### Model Recommendations

| Model                     | Size | Quality | Speed | Memory    |
| ------------------------- | ---- | ------- | ----- | --------- |
| `qwen3.6:27b`             | 27B  | Best    | Slow  | ~50GB RAM |
| `qwen3:8b`                | 8B   | Good    | Fast  | ~16GB RAM |
| `llama3.1:8b`             | 8B   | Good    | Fast  | ~16GB RAM |
| `nomic-embed-text:latest` | 8B   | Good    | Fast  | ~16GB RAM |

For production with limited resources:

```bash
SYNTHESIS_LLM_MODEL=qwen3:8b \\
SYNTHESIS_EMBED_MODEL=nomic-embed-text:latest \\
deno task start
```

### Distillation Prompt Structure

The `SYSTEM_PROMPT` in `src/distil.ts` follows this pattern:

```typescript
const SYSTEM_PROMPT = `You are a knowledge distillation expert.

Task: Extract atomic insights from the transcript.

Requirements:
- One insight per note
- Clear, descriptive title
- Self-contained body text
- No references to the original video

Return valid JSON:
{
  "summary": "Brief overview (2-3 sentences)",
  "notes": [
    {
      "title": "Descriptive title",
      "body": "Full explanation"
    }
  ]
}
`;
```

Customization tips:

- Add domain-specific extraction rules
- Modify JSON schema for custom fields
- Adjust chunk size (`SYNTHESIS_MAX_CHARS`) for your model's context window

## File Structure

### Disk Layout

```
~/.Synthesis/
├── synthesis.db          # SQLite database
├── notes/                # Markdown files
│   ├── insight-1.md
│   ├── insight-2.md
│   └── ...
└── embeddings/           # sqlite-vec data (in DB)
```

### Code Organization

```
synthesis/
├── main.ts              # Entry point, HTTP server, routing
├── src/
│   ├── config.ts        # Environment parsing, defaults
│   ├── db.ts            # SQLite wrapper, CRUD operations
│   ├── ingest.ts        # YouTube transcription, text ingestion
│   ├── distil.ts        # LLM calls, JSON parsing
│   ├── embed.ts         # Vector generation, auto-linking
│   ├── search.ts        # Hybrid search implementation
│   ├── migrate.ts       # Elixir → Deno migration
│   └── rebuild_links.ts # Manual link recomputation
├── web/
│   ├── index.html       # UI shell
│   ├── app.js           # D3.js graph, search, ingest handlers
│   └── style.css        # Styling
├── scripts/
│   ├── setup.ts         # Dependency check, model pull
│   ├── build.ts         # Cross-platform bundling
│   └── fetch_yt_dlp.ts  # yt-dlp download helper
└── docs/
    ├── DEVELOPERS.md    # Developer guide
    └── ARCHITECTURE.md  # This file
```

## Performance Considerations

### Memory Usage

- **LLM processing**: ~16-50GB depending on model size
- **Embeddings**: ~4096 floats × 4 bytes × num_notes (~16MB per 1000 notes)
- **Database**: SQLite handles millions of records efficiently
- **yt-dlp**: ~500MB-2GB during download/transcoding

### CPU/GPU

- **Ollama** uses CPU by default; configure in `~/.ollama/config.json` for GPU
- **First run** downloads models (~18GB for default config)
- **Subsequent runs** load from cache

### Recommendations

**High-memory machine (32GB+ RAM):**

```bash
SYNTHESIS_LLM_MODEL=qwen3.6:27b \\
SYNTHESIS_EMBED_MODEL=qwen3-embedding:8b \\
deno task start
```

**Limited memory (16GB RAM):**

```bash
SYNTHESIS_LLM_MODEL=qwen3:8b \\
SYNTHESIS_EMBED_MODEL=nomic-embed-text:latest \\
deno task start
```

**Very limited (8GB RAM):**

```bash
SYNTHESIS_LLM_MODEL=llama3.1:8b \\
SYNTHESIS_EMBED_MODEL=all-minilm:latest \\
SYNTHESIS_MAX_CHARS=8000 \\
deno task start
```

## Extending Synthesis

### Adding Custom Ingestion Sources

```typescript
// src/ingest.ts
export async function ingestPodcast(url: string): Promise<{
  transcript: string;
  sourceUrl: string;
  title: string;
}> {
  // Implementation
  // 1. Fetch RSS/MP3 metadata
  // 2. Download audio (future: speech-to-text)
  // 3. Return transcript object
  return { transcript, sourceUrl, title };
}

// In main.ts handler
if (path === "/api/ingest/podcast" && method === "POST") {
  const body = await req.json();
  const { url } = body;
  const ingested = await ingestPodcast(url);
  // ...continue with distillation
}
```

### Custom Embedding Models

Change the embedding model by updating the API call in `src/embed.ts`:

```typescript
const response = await fetch(
  `${apiBase}/api/embeddings`,
  {
    method: "POST",
    body: JSON.stringify({
      model: "custom-model-name", // Change this
      prompt: text,
    }),
  },
);
```

Ensure the new model produces the same vector dimensions, or update the schema.

### Custom Search Algorithms

Modify `src/search.ts` to implement custom ranking:

```typescript
export async function search(
  query: string,
  db: DB,
  config: Config,
): Promise<SearchResult[]> {
  // Your custom logic here
  // - Different fusion algorithm
  // - Additional re-ranking
  // - Metadata filtering
}
```

## Migration from Elixir Version

### Database Schema Differences

| Elixir                | Deno                        | Notes                   |
| --------------------- | --------------------------- | ----------------------- |
| `output/synthesis.db` | `~/.Synthesis/synthesis.db` | Default location change |
| Text field variations | Normalized UTF-8            | Auto-fixed in migration |
| SQLite 3.28           | SQLite 3.40+                | FTS5 improvements       |

### Running Migration

```bash
deno run --allow-all src/migrate.ts ./output/synthesis.db ~/.Synthesis/synthesis.db
```

The migration:

1. Copies all notes
2. Rebuilds FTS5 index
3. Preserves creation timestamps
4. Regenerates embeddings (optional)

## Cross-Compilation

### Building for Windows from Linux

```bash
# Install mingw-w64
sudo apt install mingw-w64

# Use Deno's desktop build (requires native toolchain)
deno eval "console.log(Deno.build.target)"  # Check current target

# Cross-compile (experimental)
DENO_TARGET=x86_64-pc-windows-gnu deno compile ...
```

### Building for macOS from Linux

Not supported directly. Use:

- GitHub Actions with `macos-` runners
- Docker with QEMU (experimental)
- Build on actual Mac hardware

### Best Approach

For production releases:

1. Build on each platform separately
2. Use `scripts/build.ts` to create bundles
3. Package setup scripts and yt-dlp binaries

## Troubleshooting Internals

### Debug Mode

Add logging to any module:

```typescript
const debug = process.env.DEBUG?.includes("synthesis:ingest");
if (debug) console.log("Ingest:", { url, startTime: Date.now() });
```

Run with:

```bash
DEBUG=synthesis:* deno task dev
```

### Database Inspection

```bash
sqlite3 ~/.Synthesis/synthesis.db
SQLite > SELECT COUNT(*) FROM notes;
SQLite > SELECT * FROM links LIMIT 10;
SQLite > .schema
```

### Ollama Logs

```bash
# Check Ollama version
ollama --version

# Pull specific model
ollama pull qwen3.6:27b

# List downloaded models
ollama list

# Check RAM usage
ollama ps
```

## License

See [LICENSE](../LICENSE).
