# Synthesis ⚗️

Turn any video or audio source into a searchable Obsidian knowledge base in minutes.

Paste a URL — YouTube, Vimeo, podcast feed, or [any of the 1,000+ sources yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) — and Synthesis extracts the transcript, distils it into atomic insights, and writes them as fully cross-linked Obsidian notes you can search instantly.

**Why this helps immediately:**
- **Save hours:** auto-extracts key insights from transcripts — no manual note-taking
- **Find answers fast:** keyword + semantic search over everything you've ingested
- **Keep control:** runs on your own approved infrastructure (local Ollama by default)

## Quick start

### 1) Install prerequisites

| Tool | Purpose | Install |
|---|---|---|
| [Obsidian](https://obsidian.md/download) | View and navigate your notes | [obsidian.md/download](https://obsidian.md/download) |
| [Elixir](https://elixir-lang.org/install.html) 1.19+ | Runs Synthesis | See below |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation) | Fetches transcripts | `pip install yt-dlp` or [see options](https://github.com/yt-dlp/yt-dlp/wiki/Installation) |
| [Ollama](https://ollama.com/download) | Local AI (LLM + embeddings) | [ollama.com/download](https://ollama.com/download) |

<details>
<summary>Installing Elixir (recommended: Mise)</summary>

The easiest cross-platform way to install Elixir is **[Mise](https://mise.jdx.dev/)**, a single tool that manages language runtimes:

**macOS / Linux:**
```bash
curl https://mise.run | sh
mise install elixir@latest
```

**Windows (PowerShell):**
```powershell
winget install jdx.mise
mise install elixir@latest
```

After installation, open a new terminal and confirm with:
```bash
elixir --version
```

> Alternatively: see the [official Elixir install guide](https://elixir-lang.org/install.html) for package-manager options (Homebrew, apt, chocolatey, asdf, etc.).

</details>

### 2) Pull the AI models

```bash
ollama pull qwen3.6:35b
ollama pull qwen3-embedding:8b
```

> **Note:** These models are large. `qwen3.6:35b` requires a GPU with ~22 GB VRAM or a machine with ~40 GB RAM for comfortable use. See the [Configuration](#configuration) section for lighter alternatives.

### 3) Start Ollama
```bash
ollama serve
```

### 4) Run Synthesis
From inside this repository:

```bash
mix deps.get
mix wiki.add <url>
```

Replace `<url>` with any supported video or audio URL, for example:
```bash
mix wiki.add https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### 5) Search your knowledge base
```bash
mix wiki.search "your query"
```

### 6) Open notes in Obsidian
Synthesis writes markdown notes to `output/` and stores its database in `synthesis.db`.
Open `output/` as (or inside) your Obsidian vault to browse and navigate your notes.

---

## Most-used commands

```bash
# Add one video / audio source
mix wiki.add <url>

# Add an entire playlist
mix wiki.add https://www.youtube.com/playlist?list=<id>

# Search within default domain (general)
mix wiki.search "antimicrobial resistance surveillance"

# Search across all domains
mix wiki.search "antimicrobial resistance surveillance" --all-domains

# Add semantic cross-links between existing notes
mix wiki.link
```

---

<details>
<summary>Need a single-file binary instead of Mix?</summary>

You can run the compiled binary directly for ingestion:

```bash
./synthesis <url>
```

Useful flags:

```bash
./synthesis --domain health --concurrency 2 <url>
```

</details>

<details>
<summary id="configuration">Configuration (developers)</summary>

Main settings are in `config/config.exs`.

| Setting | Default |
|---|---|
| `ollama_url` | `http://localhost:11434` |
| `ollama_model` | `qwen3.6:35b` |
| `ollama_model_embed` | `qwen3-embedding:8b` |
| `chunk_concurrency` | `2` |
| `cross_link_threshold` | `0.3` |
| `output_dir` | `output` |
| `db_path` | `synthesis.db` |

</details>

<details>
<summary>Troubleshooting</summary>

- **`mix: command not found`** → Elixir is not installed or not on your PATH. Follow the [Elixir install steps](#installing-elixir-recommended-mise) above.
- **`yt-dlp` errors** → install/update yt-dlp (`pip install -U yt-dlp`) and retry.
- **No semantic results** → confirm Ollama is running (`ollama serve`) and both models are pulled.
- **No transcript extracted** → check that the source URL has subtitles/captions available; yt-dlp requires these to be present.

</details>

## License

MIT
