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

1. **Fetches** transcripts from video, audio or full playlist URLs
2. **Extracts** atomic insights from transcripts using a local or approved LLM
3. **Embeds** each insight as a vector for semantic search
4. **Stores** everything in a single portable database file
5. **Writes** Obsidian-ready markdown: one note per insight, fully cross-linked
6. **Searches** by keyword or natural-language query

Each insight is self-contained and fully explicit — the LLM is instructed to
name every subject, never use ambiguous pronouns, and cross-reference related
insights by title.

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

Or via the compiled binary (no install required):

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

## How semantic search works

Synthesis uses **dual-encoder semantic search** — the same approach used by
modern retrieval systems — backed entirely by local infrastructure.

Your query is compared against every stored insight using vector similarity,
so results are based on *meaning*, not just matching words. For example,
searching `"cost reduction"` can surface insights that only mention
`"budget efficiency"`.

<details>
<summary>Technical detail</summary>

**Indexing:** When a zettel is stored, its text is embedded into a
high-dimensional float vector via Ollama and written to SQLite. The embedding
model receives a `search_document:` prefix, signalling that this is content
to be indexed.

**Querying:** At search time, your query is embedded with a `search_query:`
prefix — an asymmetry that the default Qwen3-Embedding model is specifically
trained to exploit for better retrieval. The query vector is then matched
against stored vectors using [`sqlite-vec`](https://github.com/asg017/sqlite-vec)'s
approximate nearest-neighbour (ANN) search, ranked by cosine distance.

**Cross-domain linking:** `mix wiki.link` reuses the same vector index to find
semantically related zettels across domains, applying a cosine-distance
threshold to surface only genuinely close matches.

| Step | Tool |
|---|---|
| Embedding | Ollama (`qwen3-embedding:8b` by default) |
| Vector storage | SQLite + `sqlite-vec` |
| Similarity metric | Cosine distance |
| Search type | Approximate nearest-neighbour (ANN) |

</details>

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

<details>
<summary>Stack</summary>

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

</details>

<details>
<summary>Configuration</summary>

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

</details>

<details>
<summary>Project structure</summary>

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

</details>

<details>
<summary>Why Elixir?</summary>

We need a technology choice that lends itself to writing software that is
reliable, private-first, and shippable to diverse environments including
on-premise and self-hosted servers. Elixir gives us fault-tolerant concurrency
by design (via OTP — each pipeline stage runs as a supervised process, so
failures are isolated and recoverable), a consistent functional codebase that
resists fragmentation, and Burrito for distributing self-contained binaries
without dependency headaches. In our domain, reliability and auditability
matter more than ecosystem breadth. Elixir is the right tradeoff.

</details>

---

## License

MIT
