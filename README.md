# Synthesis ⚗️

A personal knowledge distillation tool. Feed it YouTube URLs; it extracts
atomic insights, stores them as a Zettelkasten, and lets you query across
everything you've ever processed.

## What it does

1. Downloads transcripts via `yt-dlp`
2. Extracts atomic insights and a summary via a local LLM (Ollama)
3. Stores everything in SQLite with vector embeddings (`sqlite-vec`)
4. Writes Obsidian-ready markdown notes
5. Lets you search by keyword or semantic similarity

## Stack

| Concern | Tool |
|---|---|
| Runtime | Elixir / OTP |
| Transcripts | `yt-dlp` (system dep) |
| LLM | Ollama — default: `qwen3.6:35b` |
| Embeddings | Ollama — default: `qwen3-embedding:8b` |
| Database | SQLite + `sqlite-vec` |
| Notes output | Markdown (Obsidian-compatible) |
| Distribution | Burrito binary (no BEAM install required) |
| HTTP client | `Req` (used by LLM & embeddings) |

## Project structure

```
lib/synthesis/
  application.ex   # OTP supervisor
  repo.ex          # SQLite GenServer
  migrations.ex    # Raw SQL schema runner
  fetcher.ex       # yt-dlp wrapper
  extractor.ex     # Ollama LLM client
  embedder.ex      # Ollama embeddings client
  store.ex         # DB reads/writes
  writer.ex        # Markdown/Obsidian output
  queue.ex         # Pipeline GenServer
  utils.ex         # Shared helpers
  synthesis.ex     # Top-level orchestrator
  cli.ex           # CLI entrypoint (escript main)
mix/tasks/
  wiki.add.ex      # mix wiki.add <youtube_url>
  wiki.search.ex   # mix wiki.search <query>
priv/migrations/   # SQL schema files
output/            # Generated markdown notes
```

## Configuration

See `config/config.exs`. Key settings:

| Setting            | Default                    |
|---|---|
| `ollama_url`       | `http://localhost:11434`   |
| `ollama_model`     | `qwen3.6:35b`              |
| `ollama_model_embed` | `qwen3-embedding:8b`     |
| `max_retries`      | `3`   (extraction) |
| `max_fetch_retries`| `3`   (fetcher) |
| `output_dir`       | `output`                   |
| `db_path`          | `synthesis.db`             |

## Distribution

The project ships as an escript. Run it directly:

```bash
./synthesis https://www.youtube.com/watch?v=<id>
```

Or via Mix tasks:

```bash
mix wiki.add https://www.youtube.com/watch?v=<id>
mix wiki.search "<term or phrase>"
```

## Roadmap

- [x] Phase 1 — CLI pipeline
- [ ] Phase 2 — Multi‑source ingest (PDF, HTML, FHIR)
- [ ] Phase 3 — Web UI (Bandit + Plug) with drag‑and‑drop upload
- [ ] Phase 4 — Demo & funding
  - `mix demo.seed` (synthetic healthcare wiki)
  - `mix demo.start` (one‑button demo mode)
  - GitHub Actions CI on every PR
- [ ] Phase 5 — Healthcare compliance
  - HIPAA mode (PHI redaction + encryption at rest)
  - Healthcare FHIR adapter
  - Documentation & deployment guide
- [ ] Phase 6 — Release
  - Burrito binary distribution
  - Azure hosted deployment

---

## License

MIT
