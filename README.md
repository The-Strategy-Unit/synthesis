# Synthesis ⚗️

Synthesis turns video, audio, and text into a structured, searchable knowledge base —
running entirely on your own machine, with no data sent to external services.

Paste a YouTube URL (a lecture, a conference talk, a clinical interview) and Synthesis
extracts the key insights, links them to related ideas you've already captured, and lets
you search across everything - by keyword or meaning.

---

## Who is this for?

- **Clinicians and clinical teams** navigating complex, information-dense cases —
  without sending patient-relevant material to third-party AI services
- **Developers and researchers** who want a local-first, extensible knowledge
  distillation pipeline they can build on

---

## What problem does it solve?

Complex cases - unexplained diagnoses, treatment-resistant conditions, multi-system
presentations - generate enormous amounts of information spread across consultations,
literature, and guidelines. Synthesis helps you build a persistent, connected knowledge
base from that material, so you're not re-deriving the same synthesis every time you
return to a case.

Unlike general AI assistants (ChatGPT, Copilot, Claude), Synthesis runs on your own
infrastructure. Nothing leaves your machine.

---

## How it works

1. **Ingest** - paste a YouTube URL, audio file, or text source (coming soon)
2. **Transcribe** - transcript is extracted automatically
3. **Distil** - a local AI model extracts atomic insights and a summary
4. **Store** - insights are saved with semantic embeddings in a local database
5. **Search** - query by keyword or meaning across everything you've captured

---

## Privacy & data sovereignty

Synthesis is **local-first by design**, and supports approved enterprise AI providers:

- **Runs locally** - all processing via [Ollama](https://ollama.com) on your own machine;
  no API keys, no data egress, no cloud dependency
- **Azure OpenAI** - configuration-ready for organisations where Azure OpenAI is an
  approved provider; point Synthesis at your Azure endpoint in `config.exs`
- Suitable for information-governance-constrained environments
  (NHS trusts, public sector organisations)

> ⚠️ Synthesis does not process patient-identifiable data and is not a medical device.
> It is a knowledge management tool for educational and research use.

---

## Get started

<details>
<summary><strong>For clinicians and non-technical users</strong> (coming soon)</summary>

A one-click installer requiring no coding is on the roadmap. In the meantime,
Synthesis can be set up with a small amount of terminal use — the steps below
take around 10–15 minutes and only need to be done once.

Follow the **developer setup** below, then use:

```bash
./synthesis https://www.youtube.com/watch?v=<id>
./synthesis --search "your query here"
```

We'd love feedback from clinical users on what would make this easier.
[Open an issue](https://github.com/The-Strategy-Unit/synthesis/issues) or get in touch.

</details>

<details>
<summary><strong>For developers</strong></summary>

### 1. Install Elixir

The easiest cross-platform way is [Mise](https://mise.jdx.dev/):

```bash
# macOS / Linux
curl https://mise.run | sh
mise use --global elixir@latest erlang@latest
```

```powershell
# Windows
winget install jdx.mise
mise use --global elixir@latest erlang@latest
```

### 2. Install yt-dlp and Ollama

```bash
pip install yt-dlp
```

Download Ollama from [ollama.com/download](https://ollama.com/download), then:

```bash
ollama pull qwen3.6:27b
ollama pull qwen3:8b           # optional lighter alternative
ollama pull qwen3-embedding:8b
ollama serve

### 3. Clone and run

```bash
git clone https://github.com/The-Strategy-Unit/synthesis
cd synthesis
mix deps.get
mix wiki.add https://www.youtube.com/watch?v=<id>
mix wiki.search "your query"
```

</details>

---

## Configuration

<details>
<summary>Configuration options</summary>

Edit `config/config.exs` or set environment variables via `.env`.

| Setting | Default | Notes |
|---|---|---|
| `ollama_url` | `http://localhost:11434` | Change if Ollama runs on a different host |
| `ollama_model` | `qwen3.6:27b` | Lighter alternative: `qwen3:8b` |
| `ollama_model_embed` | `qwen3-embedding:8b` | |
| `chunk_concurrency` | `2` | Parallel chunks for long transcripts |
| `single_chunk_threshold` | `2500` tokens | Below this, processed in one call |
| `max_retries` | `3` | Retry attempts on LLM failure |
| `output_dir` | `output/` | Where markdown notes are written |
| `db_path` | `synthesis.db` | SQLite database location |

</details>

---

## Project structure

<details>
<summary>Codebase layout</summary>

```
lib/synthesis/
  synthesis.ex     # Top-level orchestrator
  cli.ex           # CLI entrypoint
  fetcher.ex       # yt-dlp wrapper
  extractor.ex     # LLM client - insight extraction
  chunker.ex       # Long transcript splitter
  embedder.ex      # Embeddings client
  store.ex         # DB reads/writes
  writer.ex        # Markdown/Obsidian output
  queue.ex         # Pipeline GenServer
  repo.ex          # SQLite GenServer
  migrations.ex    # Schema runner
  application.ex   # OTP supervisor

mix/tasks/
  wiki.add.ex      # mix wiki.add <url>
  wiki.search.ex   # mix wiki.search <query>

priv/migrations/   # SQL schema files
output/            # Generated notes (gitignored)
```

</details>

---

## Roadmap

Synthesis is actively developed. Current priorities:

- [ ] **Web UI** - browser-based interface for non-technical users
- [ ] **Bundled binary** - single download, no prerequisites
- [ ] **In-app knowledge graph** - replace Obsidian dependency with a built-in navigator
- [ ] **Multi-user support** - submission queue and role-based access
- [ ] **Azure deployment option** - for organisations that need hosted infrastructure

---

## Contributing

Contributions are welcome - particularly from clinicians who can help shape how
Synthesis handles complex medical knowledge.

---

## Licence

[MIT](LICENSE)
