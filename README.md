# Synthesis ⚗️

Turn long YouTube videos/playlists into a searchable Obsidian knowledge base in minutes.

**Why this helps immediately:**
- **Save hours:** auto-extracts key insights from transcripts
- **Find answers fast:** keyword + semantic search over everything you’ve ingested
- **Keep control:** runs on your own approved infrastructure (local Ollama by default)

## Quick start (non-power users)

### 1) Install prerequisites
- Elixir (1.19+)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Ollama](https://ollama.com/)

Then pull the default models:

```bash
ollama pull qwen3.6:35b
ollama pull qwen3-embedding:8b
```

### 2) Start Ollama
```bash
ollama serve
```

### 3) Run Synthesis
From this repository:

```bash
mix deps.get
mix wiki.add https://www.youtube.com/watch?v=<video_id>
```

### 4) Search your knowledge base
```bash
mix wiki.search "your query"
```

### 5) Open notes in Obsidian
Synthesis writes markdown notes to `output/` and stores its database in `synthesis.db`.
Open `output/` as (or inside) your Obsidian vault.

---

## Most-used commands

```bash
# Add one YouTube video
mix wiki.add https://www.youtube.com/watch?v=<id>

# Add a full playlist
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
./synthesis https://www.youtube.com/watch?v=<id>
```

Useful flags:

```bash
./synthesis --domain health --concurrency 2 https://www.youtube.com/watch?v=<id>
```

</details>

<details>
<summary>Configuration (power users / developers)</summary>

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

- **`mix: command not found`** → install Elixir and ensure it is on your PATH.
- **`yt-dlp` errors** → install/update yt-dlp and retry.
- **No semantic results** → confirm Ollama is running and both models are installed.
- **No transcript extracted** → verify the YouTube URL is valid and has subtitles available.

</details>

## License

MIT
