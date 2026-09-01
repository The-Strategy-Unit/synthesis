# Synthesis ⚗️

Synthesis turns scattered source material into a persistent, linked, local-first
Markdown wiki. It follows
[Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
integrate knowledge once, preserve its evidence, and let it compound over time.

Add PDFs, Markdown, text, or YouTube sources. Synthesis archives each immutable
input, composes coherent wiki pages, and proposes whether new evidence should
create, extend, or contradict existing knowledge. You review those changes
before they enter the wiki.

![A compiled wiki page beside its claim evidence and original sources](docs/assets/synthesis-reader.png)

The authoritative vault is ordinary Markdown, immutable sources, and portable
history on your device. SQLite search and vector state are derived and
rebuildable. Reading, provenance, keyword search, export, catalogue rebuild, and
undo work without an AI provider.

Synthesis is currently a single-user MVP for local use and controlled private
beta evaluation.

## What it does

```text
source
  → immutable archive
  → extract and consolidate evidence
  → propose new | merge | contradict changes
  → human review
  → cited Markdown wiki
  → search, connections, synthesis, and grounded answers
```

- Compiles evidence into developed `concept`, `entity`, and `synthesis` pages.
- Preserves many-to-many provenance from claims and pages back to immutable
  source material, including page-aware PDF evidence.
- Stages every page mutation for review by default and rejects stale proposals.
- Supports keyword and semantic search, explicit reviewed links, and clearly
  labelled semantic proximity suggestions.
- Finds cross-source relationships and possible contradictions without treating
  model confidence or cosine similarity as evidence.
- Answers questions from compiled pages with citations and can save a reviewed
  answer back into the wiki.
- Exports a portable vault, rebuilds its derived catalogue offline, and can undo
  the most recent accepted ingest.
- Works with local Ollama or an explicitly configured OpenAI-compatible
  provider; credentials stay in the operating-system credential store.

![Reviewed wiki links and mutual semantic proximity in the connections view](docs/assets/synthesis-connections.png)

Blue edges are reviewed links stored in Markdown. Grey edges are mutual
nearest-neighbour suggestions derived from embeddings: useful for exploration,
but neither confirmed relationships nor confidence scores.

## Try the guided conflict demo

The disposable trial needs no model and makes no provider call. It shows how a
wiki can preserve apparently conflicting blood-pressure trial results without
silently choosing a winner or inventing a false consensus.

Download the archive for your platform from the
[latest release](https://github.com/The-Strategy-Unit/synthesis/releases/latest),
extract it, then run:

```bash
# Linux
chmod +x synthesis-linux-x86_64
./synthesis-linux-x86_64 --trial

# macOS ARM64
chmod +x synthesis-macos-aarch64
./synthesis-macos-aarch64 --trial

# Windows PowerShell
.\synthesis-windows-x86_64.exe --trial
```

Then:

1. Open **How the evidence conflict evolved** and begin with ACCORD BP.
2. Follow SPRINT and STEP as apparent disagreement gains population context.
3. Open BPROAD, which introduces the harder diabetes primary-outcome conflict.
4. Open **Blood-pressure targets across trials** to see the scoped,
   provenance-preserving resolution.
5. Inspect the four sources, then search for `stroke hypotension hyperkalaemia`.

The trial is an evidence-synthesis demonstration, not clinical guidance. Export
the disposable vault before stopping if you want to retain changes.

## Run from source

Requirements:

- [Deno 2 or later](https://deno.com/)
- [Ollama](https://ollama.com/) for the default local-provider setup
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) only for YouTube ingestion

```bash
git clone https://github.com/The-Strategy-Unit/synthesis.git
cd synthesis
deno task setup
deno task app
```

`setup` checks Ollama and reports missing models. `app` creates or opens the
default vault at `~/Synthesis`, starts the loopback server, and opens the
browser at `http://localhost:8000`.

For the provider-free trial from a warmed checkout:

```bash
deno task trial
```

To use a remote OpenAI-compatible provider, start Synthesis, open **Provider**,
and enter separate chat and embedding endpoints, models, and API keys. Remote
providers receive the source and wiki text needed for their calls under their
own data-handling and retention terms.

The default quality-first Ollama profile uses a smaller model for high-volume
extraction and a larger model for consolidation, integration, rewriting, and
cross-source decisions. Override those roles explicitly when the defaults do not
fit the host; Synthesis reports missing models rather than silently substituting
another one. See the
[developer guide](docs/DEVELOPERS.md#configuration-reference) for every model
and provider setting.

## Everyday workflow

1. **Add source** from a PDF, Markdown or text file, pasted text, or YouTube.
2. **Review** the proposed pages and `new`, `merge`, or `contradict` decisions.
3. **Approve** only the grounded changes you want in the wiki.
4. **Explore** pages, evidence, sources, keyword/semantic search, and the graph.
5. **Synthesis review** proposes useful cross-source relationships for explicit
   confirmation.
6. **Ask wiki** answers from compiled pages with citations; save only reviewed
   answers.
7. **Wiki health** finds structural, provenance, contradiction, and orphan-page
   issues.
8. **Export vault** creates a portable backup of the authoritative material.

Trusted-video batches can apply an exact, explicitly confirmed source list
without proposal-by-proposal review. This is an efficiency option, not a quality
check: source trust does not make model output accurate.

## Vault and recovery

```text
~/Synthesis/
├── vault.json          # vault identity and format version
├── schema.md           # editable purpose and compilation policy
├── notes/              # compiled Markdown pages, index, and logical log
├── sources/            # immutable originals, text, metadata, and summaries
├── history/            # accepted-ingest revisions and undo receipts
└── synthesis.db        # rebuildable catalogue, FTS, vectors, and graph cache
```

Only one running Synthesis process should own a writable vault. Override the
location with `SYNTHESIS_VAULT`:

```bash
SYNTHESIS_VAULT="$PWD/my-vault" deno task app
```

For a downloaded Windows executable, set the vault for the current PowerShell
session, then start Synthesis without `--trial`:

```powershell
$env:SYNTHESIS_VAULT = 'C:\Users\username\My_folder\myvault'
.\synthesis-windows-x86_64.exe
```

After stopping Synthesis, you can move the complete vault directory as one unit.
Its catalogue stores vault-relative file paths, and older absolute catalogue
paths are normalised when the moved vault is next opened. A normal shutdown
closes SQLite and removes its transient WAL and shared-memory sidecars.

Use **Vault tools → Export vault** for a portable tar archive. It excludes the
rebuildable database and provider credentials. After extracting an export into
an empty directory, open it with `SYNTHESIS_VAULT`, choose **Rebuild
catalogue**, then build or resume the semantic index if semantic search is
required.

### Recompile archived sources

`scripts/recompile_vault.ts` can build a fresh wiki from another vault's
hash-checked immutable source archive without copying its existing pages,
catalogue, or history. It never mutates the source vault, requires an empty
destination, and resumes accepted sources after interruption.

```bash
SYNTHESIS_MODEL_TIMEOUT_MS=1800000 deno run \
  --allow-env \
  --allow-net=127.0.0.1:11434,localhost:11434 \
  --allow-read=. --allow-write=new-vault --allow-ffi \
  scripts/recompile_vault.ts \
  --source old-vault --destination new-vault \
  --extract-model qwen3.5:9b --editor-model qwen3.5:122b \
  --embedding-model nomic-embed-text-v2-moe:latest \
  --confirm "RECOMPILE 66 SOURCES"
```

Replace the source count with the exact number reported for your archive. Add
`--resume` when repeating the same command after an interrupted run.

## Development

```bash
deno task dev               # watch mode
deno task check             # type-check server and browser code
deno task test:unit         # permissionless logic tests
deno task test:integration  # database, filesystem, routes, and orchestration
deno task test:e2e          # provider-free server/UI workflow
deno task test:browser      # real-browser search and graph smoke
deno task compile           # QuickJS executable for the current host
```

Build a release target with `compile:linux`, `compile:macos`, or
`compile:windows`. The executables are self-extracting QuickJS packages, capped
at 80 MiB, and do not require Deno on the target machine. They are currently
unsigned; macOS builds are not notarised. Treat them as controlled
demonstration/private-beta artefacts and test them on their target OS.

Releases are tag-driven. Update `deno.json` and push its matching annotated tag:

```bash
git tag -a v0.2.0 -m "Synthesis v0.2.0"
git push origin v0.2.0
```

GitHub Actions verifies the tag, runs native compiled smoke tests on Linux,
macOS, and Windows, then publishes the platform archives, generated notes, and
`SHA256SUMS`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — runtime, boundaries, persistence, and
  compiler flow
- [Developer guide](docs/DEVELOPERS.md) — configuration, API, testing, and
  packaging

## Safety and privacy

- Model output is untrusted and requires bounded validation plus human review.
- Local Ollama keeps model processing local; remote-provider privacy depends on
  that provider.
- Do not use real patient, regulated, identifiable, or otherwise sensitive data
  in demonstrations or tests.
- Synthesis is not validated for clinical decision support or patient care.

## Licence

See [LICENSE](LICENSE).
