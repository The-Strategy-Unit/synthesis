# Synthesis ⚗️

Turn videos, audio, and text into a structured, semantically searchable
knowledge base - entirely on your own machine.

**Pipeline:** ingest → transcribe → distil → embed → search

**Quick Start** · **How It Works** · **API Reference** · **Developers** ·
**Troubleshooting**

<!-- TODO: Add screenshot of UI here -->

Synthesis ingests a source, distils it into atomic insights, automatically
detects semantic relationships between notes, and lets you search across
everything by keyword or meaning. No data leaves your machine.

Built for clinicians, clinical teams, public-sector analysts, and anyone
navigating complex, information-dense problems in environments where sending
data to third-party AI services is not an option.

## Quick Start

### Setup

**Prerequisites:**

- **Ollama** (https://ollama.ai) - for local AI models
- **Deno** (https://deno.land) - to run Synthesis
- **yt-dlp** (https://github.com/yt-dlp/yt-dlp) - for YouTube transcript
  extraction (auto-downloaded if missing)

**One-time setup** (runs once):

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno run --allow-all scripts/setup.ts
```

The setup script will:

- Check for Ollama and prompt you if not installed
- Pull required AI models (~18GB total)
- Install yt-dlp for transcript extraction

### Run

```bash
deno task start
```

The web interface opens at http://localhost:8000.

Works on Linux, macOS, and Windows.

### Your first video

1. **Paste a YouTube URL** in the "Ingest" bar at the bottom
2. **Click "Ingest"** and wait 1-2 minutes for processing
3. **View generated notes** in the left sidebar, grouped by source
4. **Open a note** to see its full content and related notes
5. **Search** using the top bar (supports semantic and keyword search)

Your notes are saved to `~/.Synthesis/notes/` as Markdown files.

### What to expect

- **First run** downloads models (~18GB) - subsequent runs are instant
- **Processing time** is ~1-2 minutes per 15-minute video
- **Auto-linking** connects semantically similar notes automatically
- **Graph view** shows relationships - adjust the similarity threshold with the
  slider

## How It Works

1. **Ingest** - paste a YouTube URL, upload text, or (future) upload audio files
2. **Transcribe** - extract a transcript locally using yt-dlp
3. **Distil** - a local AI model extracts atomic insights and summaries
4. **Embed** - generate vector embeddings for semantic search
5. **Link** - automatically detect relationships between notes
6. **Search** - query by keyword or meaning across your whole knowledge base

## Privacy and Data Sovereignty

- All processing runs locally via Ollama
- No API keys, no cloud dependency, no data egress
- Supports approved enterprise providers (Azure OpenAI) in future releases

> **Important:** Synthesis is not a medical device and must not process
> patient-identifiable data. It is a knowledge-management tool for educational
> and research use.

---

## API Reference

Synthesis runs an HTTP server on port 8000. Use these endpoints to interact with
your knowledge base or build custom integrations.

### `GET /api/status`

Check if the server is running.

```bash
curl http://localhost:8000/api/status
```

### `POST /api/ingest`

Add a new source (YouTube video or plain text).

**Request:**

```bash
curl -X POST http://localhost:8000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=<id>"}'
```

**Response:**

```json
{
  "title": "Source title",
  "summary": "AI-generated summary",
  "notes": [
    { "id": 1, "title": "First extracted insight" },
    { "id": 2, "title": "Second extracted insight" }
  ]
}
```

### `POST /api/ingest/playlist`

Process an entire YouTube playlist.

```bash
curl -X POST http://localhost:8000/api/ingest/playlist \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/playlist?list=<id>"}'
```

### `GET /api/notes`

List all notes in your knowledge base.

```bash
curl http://localhost:8000/api/notes
```

### `GET /api/notes/:id`

Get a specific note with related notes.

```bash
curl http://localhost:8000/api/notes/1
```

### `GET /api/search`

Search by keyword or meaning.

```bash
curl "http://localhost:8000/api/search?q=your+query"
```

**Response:**

```json
{
  "query": "your query",
  "results": [
    {
      "id": 1,
      "title": "Matching title",
      "score": 0.85,
      "matchType": "semantic"
    },
    { "id": 2, "title": "Keyword match", "score": 1.0, "matchType": "keyword" }
  ]
}
```

### `GET /api/graph`

Get all notes and their semantic relationships.

```bash
curl http://localhost:8000/api/graph
```

**Response:**

```json
{
  "nodes": [{ "id": 1, "title": "Note 1" }, { "id": 2, "title": "Note 2" }],
  "links": [{ "source": 1, "target": 2, "similarity": 0.82 }]
}
```

---

## Developers

For full developer documentation, including setup, configuration, extension
guides, and troubleshooting:

**→ [DEVELOPERS.md](docs/DEVELOPERS.md)**

### Quick reference

**Key tasks:**

```bash
deno task dev          # Dev server with auto-reload
deno task start        # Production mode
deno task test         # Run tests
deno task build        # Build distributable packages
```

**Override defaults:**

```bash
# Custom vault location
SYNTHESIS_VAULT=/path/to/vault deno task start

# Custom port
SYNTHESIS_PORT=8001 deno task start

# Custom models
SYNTHESIS_LLM_MODEL=llama3 deno task start

# Enable auto-reload (alias for 'dev' task)
SYNTHESIS_WATCH=true deno task start
```

**Core settings:**

| Variable                | Default              | Description                  |
| ----------------------- | -------------------- | ---------------------------- |
| `SYNTHESIS_VAULT`       | `~/.Synthesis`       | Notes and database location  |
| `SYNTHESIS_PORT`        | `8000`               | HTTP server port             |
| `SYNTHESIS_LLM_MODEL`   | `qwen3.6:27b`        | Model for insight extraction |
| `SYNTHESIS_EMBED_MODEL` | `qwen3-embedding:8b` | Model for embeddings         |
| `SYNTHESIS_WATCH`       | `false`              | Enable auto-reload mode      |

---

## Roadmap

- [ ] One-click installer (MSI/DMG) for non-technical users
- [ ] Audio file ingestion (WAV, MP3, etc.)
- [ ] Azure OpenAI support
- [ ] Shared team knowledge bases
- [ ] Cross-platform desktop app (native binaries)

---

## Troubleshooting

- **"Ollama not found"** - Start Ollama: `ollama serve`
- **"No subtitle file"** - Video lacks captions; try different language:
  `SYNTHESIS_SUBTITLES_LANG=es`
- **Slow first run** - Models are being downloaded (~18GB)
- **Custom port** - `SYNTHESIS_PORT=8001 deno task start`
- **Custom vault** - `SYNTHESIS_VAULT=/custom/path deno task start`

For comprehensive troubleshooting, see
**[docs/DEVELOPERS.md](docs/DEVELOPERS.md#troubleshooting)**.

---

## License

See [LICENSE](./LICENSE).

---

## Verification

**Check everything is working:**

```bash
# Run setup script (one-time)
deno task setup

# Start the server
deno task start

# In another terminal, verify the API responds
curl http://localhost:8000/api/status
```
