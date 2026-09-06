# Architecture

Synthesis is a local-first, single-process knowledge compiler. It stores durable
knowledge as ordinary files and treats models, SQLite, embeddings, and graph
layout as replaceable machinery.

This document describes the frozen 0.2.4 MVP. It is a design reference, not a
production-deployment specification.

## System map

```text
main.ts
├── src/app/        configuration, composition, launch, trial vault
├── src/http/       loopback HTTP/SSE, auth, validation, limits
├── src/ingest/     source extraction, model pipeline, review, apply
├── src/wiki/       Markdown, schema, links, lint, query, discovery
├── src/vault/      manifest, history, export, rebuild, undo, migration
├── src/catalogue/  rebuildable SQLite, FTS5, sqlite-vec, graph state
├── src/provider/   OpenAI-compatible transport, profiles, credentials
├── scripts/        setup, tests, migration, compilation, smoke checks
└── web/            dependency-light browser application
```

One `DB` instance owns the SQLite connection and transaction boundary. Browser
assets are served by the same loopback process.

## Ingest and review

```text
PDF / Markdown / text / YouTube
  → bounded extraction
  → SHA-256 identity and duplicate check
  → extract evidence candidates
  → consolidate coherent source-level pages
  → immutable source archive
  → decide new | merge | contradict
  → stage exact validated Markdown
  → human selects and approves changes
  → revalidate target hashes
  → recoverable files + database apply
  → update search, provenance, embeddings, and suggestions
```

PDF.js extracts text in-process and preserves page numbers. Encrypted,
image-only, oversized, or timed-out PDFs fail rather than producing ungrounded
pages. YouTube uses the external `yt-dlp` executable.

Model output is tainted input. IDs, citations, pages, tokens, links, and
response shapes are bounded and validated. A proposal never changes the wiki.
Approval must select exact changes; stale target hashes fail instead of
overwriting newer knowledge.

Approved file changes have before-images and hashes in `history/`. The complete
change set is checked before visible mutation. Database failure restores the
files. Immutable sources remain even when later processing fails.

An exact trusted-video batch may automatically select staged changes only after
`AUTO APPLY N TRUSTED SOURCES`. It still uses the same validation, stale-hash,
history, embedding, and apply path. Source trust is not model-output validation.

## Cross-source synthesis

Cross-source work has three boundaries:

1. Lexical and embedding similarity retrieve candidate page pairs.
2. A model proposes a relationship, contradiction, or possible consolidation.
3. Human confirmation writes an explicit wiki link and portable relationship
   metadata.

Similarity and model confidence never become durable knowledge automatically.
Confirmed batches require exact IDs, current page hashes, and `CONFIRM N LINKS`;
any invalid item aborts the whole batch. Confirmation links pages but does not
merge or delete them.

## Authoritative and derived state

| Vault path     | Role                                                     |
| -------------- | -------------------------------------------------------- |
| `vault.json`   | Vault identity and format version                        |
| `schema.md`    | Human-editable compilation policy                        |
| `notes/`       | Canonical Markdown pages, index, and log                 |
| `sources/`     | Immutable originals, extracted text, metadata, summaries |
| `history/`     | Accepted changes, before-images, hashes, undo receipts   |
| `synthesis.db` | Rebuildable catalogue, FTS, vectors, queues, graph cache |

Portable files are authoritative. SQLite paths are vault-relative. Export omits
SQLite and provider credentials. Catalogue rebuild validates source hashes,
Markdown, titles, links, and provenance before replacing derived rows.

The main database records pages, sources, many-to-many provenance, pending
ingest proposals, FTS content, embeddings, semantic neighbours, and discovery
review state. Proposal and discovery queues are derived MVP state and are
cleared by a catalogue rebuild.

## Search, graph, and questions

- **Keyword search** uses FTS5 and needs no provider.
- **Semantic search** uses sqlite-vec and requires complete embeddings for the
  current provider/model identity.
- **Hybrid search** combines keyword and semantic results.
- **Explicit links** come from canonical Markdown and are authoritative.
- **Semantic edges** are positive, mutual, cross-source nearest neighbours and
  remain suggestions.
- **Ask wiki** retrieves compiled pages, optionally expands semantic results,
  and follows one explicit-link hop. Saved answers require review.

Changing the embedding endpoint, model, dimensions, or recognised input format
invalidates the semantic index. Rebuilding it is bounded and resumable; links
are recreated only after complete coverage.

## Recovery

- **Export** creates a portable POSIX tar of authoritative state and rejects
  symlinks and unsafe archive paths.
- **Rebuild** reconstructs the provider-free catalogue transactionally.
- **Semantic rebuild** repopulates vectors separately with the selected
  provider.
- **Undo** accepts only the newest active ingest and requires unchanged approved
  hashes before restoring files and catalogue state.
- **Recompile** can build a new vault from another vault's hash-checked
  immutable sources without modifying the source vault.

## HTTP and security boundary

The normal server binds to `127.0.0.1`. Every API request gets a request ID and
safe error envelope. Mutation requests require an allowed origin and content
type before their bounded bodies are consumed.

Local mode uses the `local` identity. Optional protected hosting trusts
`Cf-Access-Authenticated-User-Email` only when proxy authentication and a public
origin are explicitly configured. Allowed viewers and ingesters are separate.
The frozen project does not include a supported production-deployment runbook.

Ingestion is serialized by an in-memory identity-aware gate with queue and daily
quota limits. Semantic search has a per-identity rate limit. Long operations use
SSE and cooperative cancellation; cancellation never interrupts an atomic apply.

Only one process may own a writable vault. Version 0.2.4 documents this
requirement but does not enforce a cross-process vault lock.

Provider URLs must be HTTPS OpenAI-compatible `/v1` endpoints, except loopback
HTTP for local providers. Remote providers are never selected implicitly.
Credentials live in the OS keyring or process environment, never the vault,
browser state, exports, or errors.

## Packaging

`scripts/compile.ts` creates self-extracting QuickJS executables for Linux x64,
macOS ARM64, and Windows x64. It embeds the browser runtime and target-native
SQLite/keyring packages, patches the pinned PDF.js build only for server-side
text extraction, and enforces an 80 MiB executable ceiling.

Release archives place the executable, licence, and tracked HACA vault together.
The cross-platform workflow compiles and smoke-tests each target; the smoke test
covers embedded assets, native SQLite/sqlite-vec, PDF extraction, and
provider-free trial/HACA operation. Tag releases are immutable and include
SHA-256 checksums.

## Fixed MVP boundaries

- One user, one process, one writable filesystem vault.
- Stateful SQLite/FFI, subprocess, keyring, and long-lived SSE runtime.
- No OCR, multi-user editing, serverless persistence, or distributed locking.
- No autonomous model-authored wiki mutation or relationship confirmation.
- No clinical or other consequential decision support.
- Further product architecture belongs in a separate fork.
