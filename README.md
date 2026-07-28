# Synthesis ⚗️

Turn videos, audio, and text into a structured, semantically searchable
knowledge base - entirely on your own machine.

**Pipeline:** ingest → transcribe → distil → embed → search

**[Install](#install)** · **[Quick start](#quick-start)** ·
**[How it works](#how-it-works)** · **[Roadmap](#roadmap)**

Synthesis ingests a source, distils it into atomic insights, links those
insights to what you already know, and lets you search across everything by
keyword or meaning. No data leaves your machine.

Built for clinicians, clinical teams, public-sector analysts, and anyone
navigating complex, information-dense problems in environments where sending
data to third-party AI services is not an option.

## Quick start

1. Install [Elixir](https://elixir-lang.org/install.html) via
   [Mise](https://mise.jdx.dev/):

   ```bash
   curl https://mise.run | sh
   mise use --global elixir@latest erlang@latest
   ```

2. Install yt-dlp and [Ollama](https://ollama.com):

   ```bash
   pip install yt-dlp
   ollama pull qwen3.6:27b qwen3-embedding:8b
   ```

3. Clone and run:

   ```bash
   git clone https://github.com/The-Strategy-Unit/synthesis.git
   cd synthesis
   mix deps.get
   mix wiki.add "https://www.youtube.com/watch?v=<id>"
   mix wiki.search "your query"
   ```

### Refreshing links in an existing wiki

If you generated notes before the cross-presentation linking feature, or you
want to refresh links after changing settings:

```bash
mix wiki.link         # recompute semantic links in the database
mix wiki.update_links # rewrite Related sections in all markdown notes
```

### Publish your wiki with an interactive graph

Host your generated wiki as a static site with an Obsidian-like graph view using
[Quartz](https://quartz.jzhao.xyz/):

```bash
git clone https://github.com/jackyzha0/quartz.git
cd quartz
npm i
npx quartz create -s ./../output/
npx quartz build --serve  # preview locally at localhost:8080
```

Deploy the `public/` output to Azure Static Web Apps (free tier) or GitHub
Pages.

## How it works

1. **Ingest** - paste a YouTube URL, audio file, or text.
2. **Transcribe** - extract a transcript locally.
3. **Distil** - a local model pulls out atomic insights and a summary.
4. **Store** - insights are saved with semantic embeddings in a local SQLite
   database.
5. **Search** - query by keyword or meaning across your whole knowledge base.

## Privacy and data sovereignty

- All processing runs locally via Ollama.
- No API keys, no cloud dependency, no data egress.
- Supports approved enterprise providers such as Azure OpenAI in future
  releases.

Synthesis is not a medical device and must not process patient-identifiable
data. It is a knowledge-management tool for educational and research use.

## Install

### Non-technical users

A one-click installer is on the roadmap. For now, follow the developer install
above. We welcome feedback on what would make setup easier.

### Developers

Synthesis is written in [Elixir](https://elixir-lang.org/) on the Erlang VM,
which gives us lightweight concurrency, fault tolerance, and the ability to ship
a standalone local-first binary.

Configuration is handled in `config/config.exs` or via `.env`.

| Setting                  | Default                  | Notes                                |
| ------------------------ | ------------------------ | ------------------------------------ |
| `ollama_url`             | `http://localhost:11434` | Ollama host                          |
| `ollama_model`           | `qwen3.6:27b`            | Main inference model                 |
| `ollama_model_embed`     | `qwen3-embedding:8b`     | Embedding model                      |
| `chunk_concurrency`      | `2`                      | Parallel chunks for long transcripts |
| `single_chunk_threshold` | `2500` tokens            | Below this, process in one call      |
| `max_retries`            | `3`                      | Retry attempts on LLM failure        |
| `output_dir`             | `output/`                | Markdown notes location              |
| `db_path`                | `synthesis.db`           | SQLite database location             |

## Roadmap

- [ ] One-click installer for non-technical users
- [ ] Audio and plain-text ingestion
- [ ] Azure OpenAI support
- [ ] Shared team knowledge bases

## License

See [LICENSE](./LICENSE).
