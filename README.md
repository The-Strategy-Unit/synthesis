# Synthesis ⚗️

A **privacy-first** knowledge distillation pipeline built for capturing, 
connecting and searching institutional knowledge, using approved infrastructure. 

Feed it a video, audio or playlist URL to produce a fully-linked,
semantically-searchable **Zettelkasten** knowledge base, stored locally and
rendered as Obsidian-compatible markdown.

---

## Why it matters

| Challenge | How Synthesis helps |
|---|---|
| Staff watch hours of webinars and conference talks | Transcripts are auto-extracted and distilled into atomic, citable insights |
| Knowledge is siloed across teams and domains | Every insight is tagged, cross-linked and indexed across the whole base |
| Sensitive content must stay within approved infrastructure | Runs fully locally via Ollama, or on approved cloud infrastructure |
| Analysts need to query across a large body of evidence | Dual keyword + **semantic vector search** surfaces the right insight, even without exact term matches |
| Staff turnover erodes institutional memory | Structured summaries and a growing index outlive any individual contributor |

---

## What it does

1. **Fetches** transcripts from video, audio or full playlist URLs via `yt-dlp`
2. **Chunks & extracts** - long transcripts are split, processed in parallel,
   then merged into atomic insights with a 3-paragraph summary, using a local
   LLM (Ollama) in structured JSON mode
3. **Embeds** each insight as a vector for semantic search
4. **Stores** everything in SQLite with `sqlite-vec` - a single portable file
5. **Writes** Obsidian-ready markdown: one note per insight, fully cross-linked,
   plus a per-domain index
6. **Searches** by keyword or natural-language semantic query

Each insight is self-contained and fully explicit - the LLM is instructed to
name every subject, never use ambiguous pronouns, and cross-reference related
insights by title.

---

## Stack

| Concern | Tool |
|---|---|
| Runtime | Elixir / OTP |
| Transcripts | `yt-dlp` (system dep) |
| LLM | Local or approved cloud backend (default: Ollama) |
| Embeddings | Local or approved cloud backend (default: Ollama) |
| Database | SQLite + `sqlite-vec` |
| Notes output | Markdown (Obsidian-compatible) |
| Distribution | Escript binary (no BEAM install required) |
| HTTP client | `Req` |

---

## Project structure

```
lib/synthesis/
  application.ex   # OTP supervisor
  repo.ex          # SQLite GenServer
  migrations.ex    # Raw SQL schema runner
  fetcher.ex       # yt-dlp wrapper (URL validation, playlist expansion)
  chunker.ex       # Splits long transcripts for parallel extraction
  extractor.ex     # Ollama LLM client - structured insight extraction
  embedder.ex      # Ollama embeddings client
  store.ex         # DB reads/writes (episodes, zettels, links, embeddings)
  writer.ex        # Markdown/Obsidian output + index generation
  queue.ex         # OTP GenServer pipeline (extract → embed → store)
  progress.ex      # CLI progress rendering
  utils.ex         # Shared helpers
  cli.ex           # CLI entrypoint
mix/tasks/
  wiki.add.ex      # mix wiki.add <youtube_url>
  wiki.search.ex   # mix wiki.search <query>
priv/migrations/   # SQL schema files
output/            # Generated markdown notes
```

---

## Configuration

See `config/config.exs`. Key settings:

| Setting | Default |
|---|---|
| `ollama_url` | `http://localhost:11434` |
| `ollama_model` | `qwen3:35b` |
| `ollama_model_embed` | `qwen3-embedding:8b` |
| `max_retries` | `3` (extraction) |
| `max_fetch_retries` | `3` (fetcher) |
| `output_dir` | `output` |
| `db_path` | `synthesis.db` |

---

## Usage

```bash
# Add a single video
mix wiki.add https://www.youtube.com/watch?v=<id>

# Add an entire playlist
mix wiki.add https://www.youtube.com/playlist?list=<id>

# Search (keyword or semantic)
mix wiki.search "antimicrobial resistance surveillance"
```

Or via the compiled escript:

```bash
./synthesis https://www.youtube.com/watch?v=<id>
```


### Cross-link existing zettels

Once you have zettels across multiple domains, run this once to discover and
write cross-domain connections:

```bash
mix wiki.link
```

This queries the semantic vector index to find related insights across domains,
and appends a `## Cross-domain` section with Obsidian wikilinks to each zettel.
It is safe to re-run — files that already have a `## Cross-domain` section are
skipped.

---

## Roadmap

- [x] Phase 1 - CLI pipeline (fetch → extract → embed → store → write)
    - [x] Automatic cross-domain zettel linking (`mix wiki.link`)
- [ ] Phase 2 - Web UI (Bandit + Plug, plain HTML)
- [ ] Phase 3 - Burrito binary distribution
- [ ] Swappable LLM backend (local or approved cloud, e.g. Azure OpenAI)
- [ ] Submission queue + curator approval (multi-user)
- [ ] Role-based access control
- [ ] Azure hosted deployment

---

## License

MIT
