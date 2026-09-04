# Synthesis wiki schema

## Purpose

Maintain a persistent, linked knowledge wiki from user-curated sources. Compile
durable knowledge once so that later sources and questions can build on prior
synthesis.

Synthesis supports professional knowledge management, research intelligence, and
organisational sensemaking. It augments human understanding; it does not make
clinical or other consequential decisions.

## Page types

- **entity** — a specific person, organisation, place, product, drug, disease,
  study, project, policy, or named system.
- **concept** — a reusable idea, finding, method, mechanism, process, procedure,
  or caution.
- **synthesis** — a comparison, evidence landscape, conclusion, open question,
  or cross-source analysis that connects several entities or concepts.

Create a page when the subject is a durable entity or concept that other pages
will link to. Update an existing page when evidence changes or extends the same
subject. Prefer a small number of coherent pages over near-duplicates.

## Page conventions

- Use a concise, stable, descriptive title.
- Keep each page self-contained and readable as ordinary Markdown.
- Use exact page titles for explicit wiki links.
- Preserve useful existing content, links, uncertainty, and provenance when
  updating a page.
- Do not treat semantic similarity alone as an established relationship.
- Do not place source material in the wiki unless it contributes durable
  knowledge.

## Evidence and uncertainty

- State only claims supported by the supplied sources or compiled wiki context.
- Preserve material disagreement instead of forcing a false consensus.
- Clearly distinguish reported evidence, interpretation, and an open hypothesis.
- Use cautious language when evidence is limited, indirect, disputed, or stale.
- Never present model confidence as evidential certainty.
- Retain source provenance and source locations when they are available.

## Ingest

Summarise the source, propose new pages or updates, identify contradictions, and
maintain relevant cross-references. A proposed change must be reviewable before
it becomes durable knowledge.

## Query

Answer from the compiled wiki and its immutable source provenance. Cite material
claims, include contradictory evidence, and say when the available knowledge
does not support an answer. A useful answer may be proposed as a synthesis page
for human review.

## Lint

Look for broken or missing links, near-duplicate entities, unsupported claims,
stale or superseded knowledge, unresolved contradictions, orphan pages, missing
concepts, and evidence gaps. Propose repairs for review; do not silently rewrite
factual content.

## Discoveries

Potentially useful connections may be proposed as hypotheses. Each proposal must
identify the connected pages, relationship type, significance, supporting
sources, production method, confidence, and review state. Only a human-confirmed
discovery becomes an explicit durable relationship. Optimise for useful,
evidence-backed surprise rather than graph density.

## Product boundary

Do not produce diagnosis, prognosis, triage, prescribing, treatment selection,
dosage, individual risk scoring, patient-specific recommendations, or autonomous
decisions with material consequences. In healthcare and other consequential
domains, produce evidence syntheses, knowledge maps, contradictions, gaps, and
hypotheses for professional review.
