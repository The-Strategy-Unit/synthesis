# Synthesis

Synthesis compiles scattered source material into a persistent, linked, local
wiki. It follows
[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
knowledge is integrated once and compounds over time instead of being
reconstructed from raw chunks for every question.

Each ingestion archives the immutable source, extracts durable pages, and
integrates them into the existing wiki. New evidence can create a page, merge
into one, or record a contradiction. The result is ordinary Markdown backed by
explicit provenance, semantic search, and a query interface with citations.

## MVP capabilities

- Typed `concept`, `entity`, and `synthesis` pages with explicit
  `[[wiki links]]`
- Immutable raw-source archive and many-to-many page provenance
- Incremental new/merge/contradict integration across sources
- Deterministic wiki index and machine-readable change log
- Keyword and semantic search with a relationship graph
- Wiki-grounded answers with cited pages and reviewed synthesis write-back
- Deterministic structural/provenance lint plus optional AI health analysis
- Source review showing which pages each source created or changed
- OpenAI-compatible local or remote providers with keys in the OS credential
  store

Synthesis is intended for research and knowledge-management workflows. It is not
validated clinical decision-support software. Do not use it for patient care or
regulated/identifiable data without the appropriate validation, governance,
security, and human review.

## Quick start

Prerequisites: [Deno 2 or later](https://deno.com/), and optionally
[yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube ingestion.

### Local Ollama

Install and start [Ollama](https://ollama.com/), then run:

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup
deno task start
```

The setup task checks Ollama and reports any models that still need to be
pulled. The start task creates the local vault if necessary and opens
`http://localhost:8000`.

### Remote OpenAI-compatible provider

Skip the Ollama-specific setup and start directly:

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task start
```

Open **Provider**, enter the chat and embedding endpoints, models, and API keys,
then choose **Test and save**. Endpoints must end in `/v1`. Synthesis tests both
connections before saving; profile metadata goes to the app-data directory and
keys go to the operating system credential store.

## Demo workflow

1. Configure a provider, if not using the default Ollama configuration.
2. Paste a representative source into the bottom bar and choose **Ingest**.
3. Ingest a second source that supports, extends, or contradicts the first.
4. Open **Sources** to inspect source summaries and derived-page provenance.
5. Open **Ask wiki**, ask a cross-source question, review its cited pages, and
   optionally save the answer as a new synthesis page.
6. Open **Wiki health** to inspect broken links, missing provenance,
   contradictions, orphan pages, and optional AI findings.

The notes list, relationship graph, keyword search, and semantic search update
as the wiki changes.

## Compilation pipeline

1. **Archive** — preserve the raw source, metadata, hash, and source summary.
2. **Extract** — identify durable concepts, entities, findings, procedures, and
   cautions from bounded chunks.
3. **Consolidate** — deduplicate candidate pages within the source.
4. **Integrate** — classify each page as `new`, `merge`, or `contradict` against
   the existing wiki.
5. **Rewrite** — update affected pages while preserving links and provenance.
6. **Index** — update SQLite FTS, embeddings, graph links, `index.md`, and
   `log.md`.
7. **Query** — answer from compiled pages, cite them, and optionally compile a
   reviewed answer back into the wiki.

## Storage

```text
~/Synthesis/
├── notes/
│   ├── index.md       # deterministic typed-page index
│   ├── log.md         # append-only logical change history
│   └── *.md           # compiled wiki pages
├── sources/           # immutable raw inputs, metadata, and summaries
└── synthesis.db       # catalogue, provenance, FTS, embeddings, and graph
```

Override the vault root with `SYNTHESIS_VAULT`. Provider profile metadata is
stored separately under the platform app-data directory; API keys are not stored
in the vault or profile file.

## Configuration

Configuration is defined in `src/config.ts` and can be overridden with
environment variables. Common settings are:

| Variable                      | Default                     | Purpose                  |
| ----------------------------- | --------------------------- | ------------------------ |
| `SYNTHESIS_VAULT`             | `~/Synthesis`               | Vault root               |
| `SYNTHESIS_PORT`              | `8000`                      | HTTP port                |
| `SYNTHESIS_API_BASE`          | `http://localhost:11434/v1` | Default chat API         |
| `SYNTHESIS_EXTRACT_MODEL`     | `qwen3.5:9b`                | Chunk extraction         |
| `SYNTHESIS_CONSOLIDATE_MODEL` | `qwen3.6:27b`               | Source synthesis         |
| `SYNTHESIS_INTEGRATE_MODEL`   | `qwen3.5:9b`                | Integration decisions    |
| `SYNTHESIS_REWRITE_MODEL`     | `qwen3.6:27b`               | Page rewriting           |
| `SYNTHESIS_EMBED_MODEL`       | `qwen3-embedding:8b`        | Embeddings               |
| `SYNTHESIS_EMBED_DIMENSIONS`  | `4096`                      | Required embedding width |
| `SYNTHESIS_LINK_THRESHOLD`    | `0.75`                      | Graph link threshold     |

See [docs/DEVELOPERS.md](docs/DEVELOPERS.md) for the complete configuration
reference.

## API

| Endpoint               | Method | Description                               |
| ---------------------- | ------ | ----------------------------------------- |
| `/api/status`          | GET    | Minimal server health                     |
| `/api/config`          | GET    | Non-secret UI configuration               |
| `/api/provider`        | GET    | Redacted provider status                  |
| `/api/provider`        | POST   | Test and save provider configuration      |
| `/api/notes`           | GET    | List wiki pages                           |
| `/api/notes/:id`       | GET    | Page content and related pages            |
| `/api/sources`         | GET    | List source provenance                    |
| `/api/sources/:id`     | GET    | Source summary and derived pages          |
| `/api/search?q=&mode=` | GET    | Keyword or semantic search                |
| `/api/graph`           | GET    | Wiki relationship graph                   |
| `/api/query`           | POST   | Answer from compiled pages with citations |
| `/api/query/save`      | POST   | Save a reviewed cited synthesis           |
| `/api/lint`            | GET    | Deterministic wiki health report          |
| `/api/lint/analyze`    | POST   | Optional provider-assisted health report  |
| `/api/ingest`          | POST   | Ingest URL or text with SSE progress      |
| `/api/ingest/playlist` | POST   | Ingest a YouTube playlist when enabled    |

## Development

```bash
deno task dev
deno task test:unit
deno task test:integration
deno task lint
deno task build
```

Key modules:

```text
src/wiki.ts                    typed wiki model and Markdown compiler
src/orchestrate.ts             incremental source-to-wiki compilation
src/wiki_store.ts              index, log, and cited synthesis persistence
src/query.ts                   grounded cited wiki answers
src/wiki_lint.ts               deterministic and AI-assisted wiki health
src/provider_*.ts              provider validation, runtime, and persistence
src/db.ts                      SQLite, provenance, FTS, embeddings, and links
src/routes.ts                  HTTP API and access controls
web/                           browser UI
```

## Privacy and deployment

With Ollama, model processing remains local. With a remote provider, relevant
source and wiki text is sent to that provider, so its data handling and
retention terms apply. Synthesis does not send API keys to browser responses.

For network deployment, authentication, quotas, backups, and recovery guidance,
see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Do not expose the server directly
to the internet.

## License

See `LICENSE`.
