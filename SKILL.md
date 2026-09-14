---
name: synthesis-deno-product
description: Build or review Synthesis as an auditable, local-first Deno and TypeScript knowledge product for evidence-heavy and privacy-sensitive organisations. Use for product, domain, provider, persistence, API, UI, packaging, testing, and deployment work in this repository. Do not use it to redesign contracts or add autonomous consequential decision-making.
---

# Synthesis Deno Product Engineering

Build a trustworthy product that turns evidence into durable, inspectable
knowledge. Optimise for correctness, auditability, privacy, simple operation,
and one-maintainer sustainability.

## Establish the contract

Before changing code:

1. Read the root `AGENTS.md` and the relevant parts of `README.md`,
   `docs/ARCHITECTURE.md`, and `docs/DEVELOPERS.md`.
2. Locate the current implementation, tests, fixtures, and documented failure
   behaviour for the requested capability.
3. Treat existing observable behaviour and portable vault data as the contract.
   Ask before changing an API, vault format, wiki Markdown, migration, security
   posture, or provider trust boundary.
4. Consult current official Deno documentation before changing runtime,
   permission, compilation, npm, or cross-platform behaviour. Consult the
   documentation matching every locked dependency rather than guessing its API.

Do not replace working architecture to advertise a fashionable framework. Add
technology only when it removes a demonstrated product constraint.

## Work autonomously within the repository

The project configuration permits routine inspection, implementation,
refactoring, tests, documentation, and local builds without repeated approval.
That does not authorise work outside the requested scope.

- Never read `.env`, credentials, real vaults, tester material, or private
  corpora.
- Use generated temporary vaults and mocked providers in automated tests.
- Do not push, publish, deploy, release, rewrite Git history, or mutate external
  systems unless the user explicitly requests it.
- Do not delete user work or use destructive commands. Keep all tool caches and
  temporary state in the ignored repository-local paths configured for Codex.
- Preserve unrelated worktree changes and stop when a decision would materially
  alter product behaviour or trust boundaries.

## Design for auditability and privacy

- Treat sources as immutable evidence and SHA-256 identity as authoritative.
- Preserve claim-to-source and page-to-source provenance through every
  transformation. Missing or ambiguous evidence must fail closed.
- Treat all model output as tainted input. Bound it, parse it strictly, validate
  exact identifiers and citations, and stage exact Markdown before mutation.
- Keep manual review as the default. Automatic apply is limited to the existing
  exact, bounded, count-confirmed trusted-batch contract.
- Never present semantic similarity, model confidence, or generated prose as
  verified evidence.
- Make remote inference an explicit user choice. Never silently fall back from
  local to remote compute or transmit vault content to an unselected provider.
- Keep browsing, evidence inspection, keyword search, explicit links, lint,
  export, rebuild, and undo useful without a provider.
- Keep Synthesis outside diagnosis, treatment, clinical decision support, and
  autonomous consequential decisions.

## Write direct Deno and TypeScript

- Prefer small typed functions and explicit data flow over layers, registries,
  generic frameworks, or speculative abstractions.
- Keep deterministic domain transformations pure. Put filesystem, SQLite, HTTP,
  subprocess, clock, credential, and provider effects at narrow boundaries.
- Validate unknown data once at each boundary and convert it into precise domain
  types. Do not spread unchecked casts or optional data through the core.
- Model expected failure explicitly and preserve actionable safe errors. Do not
  swallow exceptions, leak paths or secrets, or return provider internals.
- Use readable pipelines for transformations, but name intermediate values when
  they make evidence flow or rollback behaviour easier to inspect.
- Follow Deno's formatter, linter, type checker, explicit module extensions,
  import map, frozen lockfile, and least-privilege permission conventions.
- Keep browser logic dependency-light. Extract a focused pure module only when
  it improves testing or comprehension; keep accessibility and keyboard use
  first-class.

## Preserve recoverable storage

- Portable Markdown, sources, history, manifest, and schema are authoritative.
  SQLite, FTS, embeddings, and semantic links are derived and rebuildable.
- Preserve one writable process per vault and serialized ingest ownership.
- Validate a complete change set and recheck target hashes immediately before
  apply. Stale proposals must fail.
- Pair filesystem rollback with a single SQLite transaction. Never expose a
  half-applied ingest.
- Keep export credential-free, rebuild provider-free, and undo newest-only and
  hash guarded.
- Use SQLite locally, PostgreSQL only for an authorised multi-user persistence
  redesign, and DuckDB only for a demonstrated analytical workload. Do not let a
  database choice silently change the portable vault contract.

## Keep inference replaceable

- Depend on Synthesis' validated provider interface, not vendor-specific model
  behaviour.
- Keep chat and embedding roles explicit, bounded, independently testable, and
  compatible with local or explicitly configured OpenAI-compatible endpoints.
- Make timeouts, token limits, concurrency, cancellation, structured-output
  recovery, and model/index compatibility visible and deterministic.
- Characterise a provider adapter with mocked HTTP before manual hardware or
  model acceptance. Provider acceptance supplements automated tests; it never
  replaces them.
- Do not add agent loops, hidden tool execution, or autonomous mutation as a
  shortcut for a deterministic compiler workflow.

## Control dependencies and deployment complexity

Prefer Deno, browser, and operating-system facilities or an existing locked
dependency. Before adding a production dependency, model provider, native addon,
or service, obtain the required approval and establish:

- the product capability it enables and why existing facilities are inadequate;
- maintenance, ownership, licence, advisories, transitive size, and offline
  behaviour;
- permission, privacy, native packaging, target-platform, and removal costs;
- the smallest credible alternative.

Preserve local-first as the default deployment. A packaged local application,
hybrid deployment, and hosted service may share domain behaviour, but cloud
persistence, identity, tenancy, and operations require explicit designs rather
than deployment flags.

## Implement one proved slice at a time

1. Reproduce the current failure or write a focused behavioural test.
2. Make the smallest coherent change at the owning module and boundary.
3. Test the happy path and principal failure path with exact assertions.
4. Run the smallest relevant check after each meaningful edit, then every
   applicable gate in `AGENTS.md`.
5. Review the diff for contract drift, lost provenance, unsafe remote transfer,
   partial writes, duplicated logic, dependency bloat, and generated artefacts.

Never weaken, skip, quarantine, or make tests exclusive to obtain a green run.
Report unavailable hardware, network services, target operating systems, and
manual acceptance paths as unverified.

## Definition of done

A change is complete only when its observable behaviour is documented where
needed, critical invariants have regression coverage, applicable checks pass,
the provider-free product still works, and the final diff contains only intended
source files. Describe behaviour and remaining risk, not merely filenames.
