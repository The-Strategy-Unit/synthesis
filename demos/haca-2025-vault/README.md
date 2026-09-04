# HACA 2025 Synthesis vault

This is a local-first
[Synthesis](https://github.com/The-Strategy-Unit/synthesis) knowledge vault
compiled from 66 recordings from the 2025 Health and Care Analytics Conference
(HACA). It contains 344 AI-drafted wiki pages about the projects, methods,
findings, people, and organisations discussed at the conference.

The vault intentionally keeps Synthesis `[[wiki links]]`. Open the directory as
a vault in Synthesis to use linked navigation, search, source provenance, and
the knowledge graph.

From an extracted Synthesis release archive, run the executable with
`--vault haca-2025-vault`. From a source checkout, use:

```bash
SYNTHESIS_VAULT="$PWD/demos/haca-2025-vault" deno task app
```

## Contents

- `notes/` — 344 substantive wiki pages, plus the generated index and ingest log
- `sources/` — 66 immutable source archives with transcript-derived evidence
- `history/` — accepted ingest revisions and provenance records
- `synthesis.db` — the rebuildable search, provenance, and semantic catalogue
- `schema.md` and `vault.json` — the vault's content rules and identity

## How it was compiled

The recorded compilation used:

- `qwen3.6:27b` for extraction and editing
- `nomic-embed-text-v2-moe:latest` for embeddings

The resulting pages are AI-drafted. A publication review checked names and
organisation names against the official HACA programme and relevant primary
sources, reconciled recurring spelling variants, and compared numerical claims
with their archived source transcripts. This is a consistency and
source-checking pass, not independent verification of every statement made by a
speaker.

## Provenance and interpretation

Claims in wiki pages carry Synthesis source markers and link back to their
recordings. The source archive and ingest history are retained unchanged as the
historical record, so original video titles or transcripts may still contain
automatic-transcription spelling errors that have been corrected in the live
wiki and derived catalogue.

Statistics, conclusions, and descriptions generally report what was presented at
HACA 2025 and should be read in that context. A wiki link is a navigation aid,
not proof of causation or endorsement. Semantic proximity suggestions are model
derived and are not evidence of a confirmed relationship.

## Limitations

- Automatic transcripts and model-written summaries can omit nuance or retain
  errors.
- Conference claims may be preliminary, local, time-bound, or dependent on
  assumptions not fully reproduced in a short wiki page.
- Organisations, job titles, programmes, and external links may change after the
  conference.
- This vault is for research and knowledge navigation. It is not clinical
  guidance and must not be used for diagnosis, treatment, triage, or individual
  care decisions.

For consequential use, follow the cited recording and verify the claim against
the underlying work or a current authoritative source.

## Corrections

To report a factual error, attribution problem, or requested removal, contact
the vault author directly through the repository owner's GitHub profile. Include
the page title, the disputed wording, and supporting evidence where possible.
