# Developer Guide

This guide covers installing Synthesis from source, extending it, and
contributing.

## Prerequisites

- **Deno** ≥ 1.40: [Install from deno.land](https://deno.land)
- **Ollama**: [Install from ollama.ai](https://ollama.ai)
- **yt-dlp** (optional, auto-installed by setup script): For YouTube transcript
  extraction

## Quick Setup

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno run --allow-all scripts/setup.ts
deno task start
```

The web interface opens at http://localhost:8000.

## Development Workflow

### Run with auto-reload

```bash
deno task dev
```

### Run in production mode (no watch)

```bash
deno task start
```

### Run tests

```bash
deno task test
```

### Desktop app development

The app runs in Deno's desktop mode (web view wrapper):

```bash
deno task desktop:start   # Start the desktop window
deno task desktop:dev     # Start with auto-reload
```

### Cross-compilation (building for Windows)

To create a distributable bundle for another platform:

```bash
# Build for current platform
deno task build

# Platform-specific targets (in progress):
deno task build:windows   # x86_64-pc-windows-msvc
deno task build:macos     # aarch64-apple-darwin
deno task build:linux     # x86_64-unknown-linux-gnu
```

> **Note**: Cross-compilation requires platform-specific dependencies. Running
> `deno task build` creates setup scripts and bundled `yt-dlp` for each
> platform. Actual native binaries are built using `deno desktop build` on the
> target platform.

## Configuration

Create a `.env` file in the project root, or set environment variables:

### Core settings

| Variable          | Default        | Description                           |
| ----------------- | -------------- | ------------------------------------- |
| `SYNTHESIS_VAULT` | `~/.Synthesis` | Root directory for database and notes |
| `SYNTHESIS_PORT`  | `8000`         | HTTP server port                      |

### AI model settings

| Variable                | Default                     | Description                                 |
| ----------------------- | --------------------------- | ------------------------------------------- |
| `SYNTHESIS_API_BASE`    | `http://localhost:11434/v1` | Ollama API endpoint                         |
| `SYNTHESIS_API_KEY`     | `ollama`                    | API key (use "ollama" for local Ollama)     |
| `SYNTHESIS_LLM_MODEL`   | `qwen3.6:27b`               | Model for distillation (insight extraction) |
| `SYNTHESIS_EMBED_MODEL` | `qwen3-embedding:8b`        | Model for semantic embeddings               |

### Processing settings

| Variable                   | Default | Description                                          |
| -------------------------- | ------- | ---------------------------------------------------- |
| `SYNTHESIS_MAX_CHARS`      | `12000` | Max characters per transcript chunk                  |
| `SYNTHESIS_LINK_THRESHOLD` | `0.75`  | Similarity threshold for auto-linking notes          |
| `SYNTHESIS_SUBTITLES_LANG` | `en`    | Preferred subtitle language (e.g., `es` for Spanish) |

## Architecture Overview

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

### Core data flow

```
YouTube URL → ingest.ts (yt-dlp) → transcript
transcript → distil.ts (LLM chunking + JSON extraction) → atomic notes
notes → embed.ts (embedding API) → vectors stored in SQLite vec0
search → search.ts (FTS5 + vec0 hybrid) → ranked results
```

### Database schema

```sql
notes
  ├── id (PK)
  ├── title
  ├── file_path
  ├── source_url
  ├── source_type (youtube | text)
  └── created_at

embeddings (sqlite-vec virtual table)
  ├── note_id (PK)
  └── vector FLOAT[4096] (cosine distance)

links
  ├── source_note_id (FK)
  ├── target_note_id (FK)
  └── similarity (REAL)

notes_fts (fts5 virtual table)
  ├── rowid
  ├── title
  └── content
```

## Extending Synthesis

### Adding a new ingestion source

1. Add fetch logic to `src/ingest.ts` (return `{transcript, sourceUrl, title}`)
2. Call from `main.ts` `/api/ingest` handler
3. Update `source_type` in `db.addNote()` call

Example for podcast RSS feeds:

```typescript
export async function ingestPodcast(url: string) {
  // Fetch RSS, extract MP3 URL, get transcript (future: speech-to-text)
  return { transcript, sourceUrl: url, title };
}
```

### Customizing the distillation prompt

Edit `SYSTEM_PROMPT` in `src/distil.ts`:

```typescript
const SYSTEM_PROMPT = `You are a knowledge distillation expert...
// Adjust extraction rules, JSON schema, or note formats
`;
```

Tips:

- Keep the JSON schema stable
- Test with short transcripts first
- Adjust `SYNTHESIS_MAX_CHARS` for longer context windows

### Building a custom UI

The `web/` directory serves static files at `/`. Use these API endpoints:

```javascript
// Fetch all notes
const notes = await fetch("http://localhost:8000/api/notes").then((r) =>
  r.json()
);

// Search
const results = await fetch(
  "http://localhost:8000/api/search?q=clinical+guidelines",
).then((r) => r.json());

// Get graph data for visualization
const graph = await fetch("http://localhost:8000/api/graph").then((r) =>
  r.json()
);

// Get a specific note with related notes
const note = await fetch("http://localhost:8000/api/notes/1").then((r) =>
  r.json()
);
```

### Running with custom permissions

The `start` task grants specific permissions. For custom setups:

```bash
deno run \
  --allow-net \
  --allow-read=web,${HOME}/Synthesis,/tmp \
  --allow-write=${HOME}/Synthesis,/tmp \
  --allow-run=yt-dlp,ollama \
  --allow-env \
  main.ts
```

### Migrating from Elixir version

If you have an existing Synthesis database from the Elixir version (located at
`./output/synthesis.db`):

```bash
deno run --allow-all src/migrate.ts ./output/synthesis.db ~/.Synthesis/synthesis.db
```

### Publishing your wiki as a static site

Use [Quartz](https://quartz.jzhao.xyz/) to host your generated notes with an
interactive graph:

```bash
git clone https://github.com/jackyzha0/quartz.git
cd quartz
npm install
npx quartz create -s ~/.Synthesis/notes/
npx quartz build --serve  # Preview at localhost:8080
```

Deploy the `public/` output to Azure Static Web Apps or GitHub Pages.

## Troubleshooting

### "Ollama not found"

Ollama isn't running or isn't in your PATH.

```bash
# Start Ollama
ollama serve

# Check it's running
curl http://localhost:11434/api/version
```

### "No subtitle file found"

The video lacks English auto-captions. Try a different language:

```bash
SYNTHESIS_SUBTITLES_LANG=es deno task start  # Spanish
```

Or use videos that have human-generated captions.

### LLM API errors

1. Ensure Ollama is running: `ollama serve`
2. Check that the model is pulled: `ollama pull qwen3.6:27b`
3. Verify `SYNTHESIS_API_BASE` is `http://localhost:11434/v1`

### Slow embeddings

The `qwen3-embedding:8b` model is large. For faster processing:

```bash
SYNTHESIS_EMBED_MODEL=nomic-embed-text:latest deno task start
```

Smaller models are faster but may produce lower-quality embeddings.

### Link computation failing

The auto-linking threshold may be too strict or models need refresh:

```bash
deno run --allow-all scripts/rebuild_links.ts
```

### Desktop app won't start

Firewall may block localhost connections. The app runs a local web server on
port 8000.

**Windows**: Add firewall exception for Node/Deno **macOS**: Allow localhost
connections in Network Preferences

### Memory usage high

Large videos or playlists consume RAM during processing. Close other
applications or:

```bash
# Use smaller models for lighter memory footprint
SYNTHESIS_LLM_MODEL=qwen3:8b SYNTHESIS_EMBED_MODEL=nomic-embed-text:latest deno task start
```

### Port already in use

Change the port:

```bash
SYNTHESIS_PORT=8001 deno task start
```

### Setup script fails on Windows

PowerShell execution policy may block scripts. Run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

Or run commands manually:

```powershell
# Install yt-dlp
winget install yt-dlp.yt-dlp

# Pull Ollama models
ollama pull qwen3.6:27b
ollama pull qwen3-embedding:8b
```

## Contributing

### Code style

- Use TypeScript for backend (`src/*.ts`)
- Use modern JavaScript (ES modules) for frontend (`web/*.js`)
- Follow existing patterns for new features
- Add tests for new public APIs

### Submitting changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `deno task test` to ensure tests pass
5. Submit a pull request

### Development tasks reference

```bash
deno task setup            # Initial setup (check deps, pull models)
deno task dev              # Dev server with auto-reload
deno task start            # Production mode
deno task test             # Run tests
deno task migrate          # Migrate from Elixir DB
deno task build            # Build distributable packages
deno task desktop:start    # Desktop app (production)
deno task desktop:dev      # Desktop app (with hot reload)
```

## FAQ

### How are notes saved?

Notes are saved as Markdown files in `~/.Synthesis/notes/` and indexed in the
SQLite database.

### Can I use a different LLM provider?

Yes! Set `SYNTHESIS_API_BASE` to your provider's endpoint. Azure OpenAI support
is coming in a future release.

### How does semantic search work?

We use `sqlite-vec` for vector embeddings and FTS5 for keyword search. Results
are merged using reciprocal rank fusion.

### Can I disable auto-linking?

Auto-linking runs after each ingestion. To disable, set
`SYNTHESIS_LINK_THRESHOLD=1.0` (will never link).

## License

See [LICENSE](./LICENSE).
