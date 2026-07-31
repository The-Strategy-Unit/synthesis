# Synthesis ⚗️

Turn scattered source material into a persistent local knowledge base.

Synthesis ingests YouTube videos or pasted text, distils them into compact
markdown notes, integrates new material into existing notes, builds semantic
links, and lets you explore everything through search and a graph view.

Everything runs locally against an OpenAI-compatible API - by default, Ollama.

## Quick start

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup    # checks Ollama, yt-dlp, pulls models
deno task start    # opens http://localhost:8000
```

**Prerequisites:** [Deno](https://deno.land), [Ollama](https://ollama.com),
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (for YouTube ingestion).

## How it works

1. **Ingest** - YouTube transcript via yt-dlp, or pasted text
2. **Extract** - small model extracts candidate atomic notes from chunks
3. **Consolidate** - larger model deduplicates and synthesises into final notes
4. **Integrate** - each note is classified as `new`, `merge`, or `contradict`
5. **Rewrite** - merged/contradicted notes are rewritten in place
6. **Embed & link** - embeddings stored in sqlite-vec, semantic links computed
7. **Search & explore** - keyword or semantic search + graph view

## Storage

```
~/Synthesis/
├── notes/          # markdown files (your knowledge base)
└── synthesis.db    # SQLite: metadata, embeddings, links, FTS5 index
```

Override with `SYNTHESIS_VAULT`.

## Configuration

All settings are in `src/config.ts` and overridable via environment variables.
Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `SYNTHESIS_VAULT` | `~/Synthesis` | Vault root |
| `SYNTHESIS_PORT` | `8000` | HTTP port |
| `SYNTHESIS_API_BASE` | `http://localhost:11434/v1` | LLM API endpoint |
| `SYNTHESIS_EXTRACT_MODEL` | `qwen3.5:9b` | Chunk extraction |
| `SYNTHESIS_CONSOLIDATE_MODEL` | `qwen3.6:27b` | Source synthesis |
| `SYNTHESIS_INTEGRATE_MODEL` | `qwen3.5:9b` | New/merge/contradict |
| `SYNTHESIS_REWRITE_MODEL` | `qwen3.6:27b` | Note rewriting |
| `SYNTHESIS_EMBED_MODEL` | `qwen3-embedding:8b` | Embeddings |
| `SYNTHESIS_LINK_THRESHOLD` | `0.75` | Graph link threshold |

See [docs/DEVELOPERS.md](docs/DEVELOPERS.md) for the full configuration reference.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Server health and model info |
| `/api/config` | GET | Effective runtime config |
| `/api/notes` | GET | List all notes |
| `/api/notes/:id` | GET | Single note with related notes |
| `/api/search?q=&mode=` | GET | Keyword or semantic search |
| `/api/graph` | GET | Nodes and links for graph view |
| `/api/ingest` | POST | Ingest URL or text (SSE streaming) |
| `/api/ingest/playlist` | POST | Ingest YouTube playlist (SSE) |

## Deno tasks

| Task | Description |
|---|---|
| `setup` | First-run setup (Ollama, yt-dlp, models) |
| `start` | Start server |
| `dev` | Start with auto-reload |
| `migrate` | Migrate from legacy Elixir DB |
| `build` | Create platform distributables |
| `lint` | Lint + format |
| `test` | Run tests |

## Project structure

```
main.ts                  # HTTP server + ingest orchestration
src/
├── config.ts            # Central configuration with env overrides
├── db.ts                # SQLite, sqlite-vec, FTS5, embeddings, links, search
├── distil.ts            # LLM extraction, consolidation, integration, rewriting
├── ingest.ts            # YouTube transcript fetching via yt-dlp
├── migrate.ts           # Legacy Elixir → Deno migration
├── rebuild_links.ts     # Manual link recomputation utility
└── utils.ts             # Shared helpers (slugify)
scripts/                 # setup, start, build, migrate, test, yt-dlp helpers
web/                     # Frontend (HTML, CSS, JS)
docs/                    # Architecture and developer docs
```

## Privacy

All processing runs locally. No data leaves your machine when using Ollama.
Point `SYNTHESIS_API_BASE` at a remote provider if you accept that provider's
data handling terms.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - component design, data flow, schema
- [Developer Guide](docs/DEVELOPERS.md) - setup, config reference, extending, troubleshooting

## License

See `LICENSE`.
