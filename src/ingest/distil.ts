// Distil: transcript → extract (small model, parallel) → consolidate (big model)

import { config } from "../app/config.ts";
import {
  LlmServiceError,
  parseJsonResponse,
  structuredChatCompletion,
} from "../provider/llm.ts";
import { validateWikiPage, type WikiPage } from "../wiki/wiki.ts";
import {
  DEFAULT_WIKI_SCHEMA,
  promptWithWikiSchema,
  validateWikiSchema,
} from "../wiki/wiki_schema.ts";

export type DistilNote = WikiPage & { sourcePages?: number[] };

export interface DistilResult {
  summary: string;
  notes: DistilNote[];
}

const MAX_CHUNKS = 32;
const EXTRACTION_CONCURRENCY = 3;
const MAX_ITEMS_PER_CHUNK = 8;
const MAX_CANDIDATES = MAX_CHUNKS * MAX_ITEMS_PER_CHUNK;
const MAX_FINAL_NOTES = 8;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_TAGS = 3;
const MAX_TAG_LENGTH = 64;
const MAX_LINKS = 8;
const MAX_SOURCE_PAGES = 50;

// --- Transcript chunking ---

function splitTranscript(
  text: string,
  maxChars: number,
  overlap: number,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    let chunk = text.slice(pos, end);
    if (pos > 0 && /^## PDF page \d+\n\n/.test(text)) {
      const activePage = text.slice(0, pos).match(/^## PDF page (\d+)$/gm)
        ?.at(-1)?.match(/\d+/)?.[0];
      if (activePage && !/^## PDF page \d+/.test(chunk)) {
        chunk = `## PDF page ${activePage} (continued)\n\n${chunk}`;
      }
    }
    chunks.push(chunk);
    if (end === text.length) break;
    pos = end - overlap;
  }
  return chunks;
}

// --- Stage 1: Extract (small model, runs in parallel per chunk) ---

const EXTRACT_PROMPT =
  `You are preparing evidence for a persistent knowledge wiki. Read the text and extract durable topical candidates that a later editor can compose into coherent wiki pages.

Rules:
- Extract 2-8 substantial candidates. Group claims that explain the same topic; do not split every fact, quotation, or example into its own item.
- Each title: 2-10 words, descriptive, unique, and suitable as a stable wiki heading.
- Type each page as "concept", "entity", or "synthesis". Use "entity" for a specific person, organisation, place, product, drug, disease, study, or named system. Use "concept" for a reusable idea, finding, method, process, or caution. Use "synthesis" only for a comparison or conclusion that connects multiple ideas in this source.
- Each body: a self-contained evidence brief that preserves the important context, mechanism, qualifications, examples, and quantities available for that topic. Prefer a few connected paragraphs over isolated sentences, but do not pad thin evidence.
- Omit introductions, housekeeping, promotional material, and incidental anecdotes unless they provide durable context for another candidate.
- Do not refer to "the video", "the speaker", or the extraction process.
- Only extract what is explicitly stated. Do not invent or speculate.
- Treat unfamiliar names, organisations, places, and acronyms in transcripts as potentially mistranscribed. Do not create a named-entity page from an ambiguous transcription; use a supported generic subject or omit the uncertain detail instead.
- Preserve names, dates, quantities, units, scope, attribution, and uncertainty exactly as supported. Do not silently correct them using outside knowledge.
- Tags: 1-3 lowercase keywords.
- Links: 0-5 exact titles of other extracted pages that materially help explain this page. Do not link a page to itself.
- When the source contains "## PDF page N" headings, include "source_pages" with the 1-50 page numbers that directly support the item. Never infer a page number. Otherwise omit "source_pages".

Respond with ONLY JSON, no markdown fences:
{"items": [{"title": "...", "type": "concept", "body": "...", "tags": ["..."], "links": ["..."], "source_pages": [1]}]}`;

type ExtractedItem = DistilNote;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  const result = value.trim();
  if (result.length === 0) throw new Error(`${context} must not be empty`);
  if (result.length > maxLength) {
    throw new Error(`${context} exceeds ${maxLength} characters`);
  }
  return result;
}

function parseNote(value: unknown, context: string): DistilNote {
  const note = asRecord(value, context);
  const parsed = validateWikiPage({
    ...note,
    tags: Array.isArray(note.tags) ? note.tags.slice(0, MAX_TAGS) : note.tags,
    links: note.links ?? [],
  });
  if (parsed.body.length > MAX_BODY_LENGTH) {
    throw new Error(`${context}.body exceeds ${MAX_BODY_LENGTH} characters`);
  }
  if (parsed.tags.length === 0) {
    throw new Error(`${context}.tags must contain at least one item`);
  }
  if (parsed.links.length > MAX_LINKS) {
    throw new Error(`${context}.links must contain at most ${MAX_LINKS} items`);
  }

  let sourcePages: number[] | undefined;
  if (note.source_pages !== undefined) {
    if (
      !Array.isArray(note.source_pages) ||
      note.source_pages.length > MAX_SOURCE_PAGES ||
      note.source_pages.some((page) =>
        !Number.isSafeInteger(page) || (page as number) < 1
      )
    ) {
      throw new Error(
        `${context}.source_pages must contain at most ${MAX_SOURCE_PAGES} positive integers`,
      );
    }
    const pages = [...new Set(note.source_pages as number[])].sort((a, b) =>
      a - b
    );
    if (pages.length > 0) sourcePages = pages;
  }

  return {
    title: boundedString(parsed.title, `${context}.title`, MAX_TITLE_LENGTH),
    type: parsed.type,
    body: parsed.body,
    tags: parsed.tags.map((tag, index) =>
      boundedString(tag, `${context}.tags[${index}]`, MAX_TAG_LENGTH)
    ),
    links: parsed.links,
    ...(sourcePages ? { sourcePages } : {}),
  };
}

function parseNoteArray(
  value: unknown,
  context: string,
  maxItems: number,
  resolveLinks = true,
): DistilNote[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  if (value.length === 0 || value.length > maxItems) {
    throw new Error(
      `${context} must contain 1-${maxItems} notes; received ${value.length}`,
    );
  }
  const notes = value.map((note, index) =>
    parseNote(note, `${context}[${index}]`)
  );
  const titles = new Map<string, string>();
  for (const note of notes) {
    const title = note.title.toLocaleLowerCase("en-GB");
    if (titles.has(title)) {
      throw new Error(`${context} contains duplicate page title ${note.title}`);
    }
    titles.set(title, note.title);
  }
  if (!resolveLinks) return notes;
  return notes.map((note) => ({
    ...note,
    links: note.links.flatMap((link) => {
      const title = titles.get(link.toLocaleLowerCase("en-GB"));
      return title ? [title] : [];
    }),
  }));
}

async function extractChunk(
  chunk: string,
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string,
  signal?: AbortSignal,
): Promise<ExtractedItem[]> {
  return await structuredChatCompletion(
    "Extraction response",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(EXTRACT_PROMPT, schema),
    chunk,
    {
      temperature: config.llm.extractTemperature,
      maxTokens: config.llm.extractMaxTokens,
      jsonMode: true,
      signal,
    },
    (content) => {
      const parsed = asRecord(
        parseJsonResponse(content, "Extraction response"),
        "Extraction response",
      );
      return parseNoteArray(
        parsed.items,
        "Extraction response.items",
        MAX_ITEMS_PER_CHUNK,
        false,
      );
    },
  );
}

// --- Stage 2: Consolidate (big model, single call) ---

const CONSOLIDATE_PROMPT =
  `You are the source-level editor of a persistent knowledge wiki. Compose the candidate evidence into a small, coherent set of durable wiki pages. This is a wiki, not a Zettelkasten: a page should explain a useful subject, not preserve one miniature note per claim.

Rules:
- Group candidates that belong to the same entity, concept, method, evidence theme, or comparison into one readable page.
- Merge near-duplicates, aliases, continuations, and examples into the relevant broader page.
- Compare meaning as well as wording. Treat abbreviations and plausible spelling or transcription variants as possible aliases, but do not merge distinct subjects merely because their names are similar.
- Remove redundant, trivial, administrative, promotional, or source-specific items that will not remain useful outside their original setting.
- Rank final pages from most to least durable and useful.
- Produce only as many pages as the source supports, usually 1-6. HARD LIMIT: never return more than 8 pages. Do not aim for a quota.
- Each title: 2-10 words, descriptive, unique, and broad enough to remain stable as later sources extend it. Titles serve as labels in a knowledge graph.
- Preserve or correct each page type using only "concept", "entity", or "synthesis".
- Each body: coherent explanatory prose, normally 2-5 short paragraphs and roughly 100-450 words when the evidence supports that depth. Preserve context, mechanisms, important examples, quantities, limitations, and uncertainty. Do not pad a thin source to meet a length target.
- Prefer one developed topical page over several pages that would be understandable only when read together.
- Do not refer to "the video", "the speaker", the candidates, or the compilation process.
- Tags: 1-3 lowercase keywords.
- Links: 0-8 exact titles of other pages in the final response. Every link target must exist, materially help explain the source page, and must not be a self-link.
- Preserve and combine "source_pages" from candidates. When candidates cite PDF pages, every final page must include the exact supporting page numbers and no others.
- Only include information present in the candidates. Do not invent.
- Do not use outside knowledge to repair a candidate's name or factual detail. Preserve uncertainty or omit a detail that the candidates do not resolve.

Respond with ONLY JSON, no markdown fences:
{"notes": [{"title": "...", "type": "concept", "body": "...", "tags": ["..."], "links": ["..."], "source_pages": [1]}]}`;

function parseConsolidatedNotes(value: unknown): DistilNote[] {
  if (!Array.isArray(value)) {
    throw new Error("Consolidation response.notes must be an array");
  }
  if (value.length > MAX_CANDIDATES) {
    throw new Error(
      `Consolidation response.notes exceeds the safe limit of ${MAX_CANDIDATES}; received ${value.length}`,
    );
  }
  return parseNoteArray(
    value.slice(0, MAX_FINAL_NOTES),
    "Consolidation response.notes",
    MAX_FINAL_NOTES,
  );
}

function plainSummaryText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/^[\s]*[#>*+-]+[\s]+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedSummaryExcerpt(value: string, maxLength = 260): string {
  const text = plainSummaryText(value);
  if (text.length <= maxLength) return text;
  const boundary = text.lastIndexOf(" ", maxLength - 1);
  const end = boundary >= Math.floor(maxLength * 0.7)
    ? boundary
    : maxLength - 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function sourceSummary(notes: DistilNote[]): string {
  const findings = notes.slice(0, 3).map((note) =>
    `${boundedSummaryExcerpt(note.title, 120)} — ${
      boundedSummaryExcerpt(note.body)
    }`
  );
  const remaining = notes.length - findings.length;
  const summary = `Key findings: ${findings.join(" ")}${
    remaining > 0
      ? ` ${remaining} additional finding${
        remaining === 1 ? "" : "s"
      } captured.`
      : ""
  }`;
  return boundedString(summary, "Source summary", MAX_SUMMARY_LENGTH);
}

async function consolidateCandidates(
  candidates: ExtractedItem[],
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string,
  signal?: AbortSignal,
): Promise<DistilResult> {
  const providerCandidates = candidates.map((candidate) => {
    const { sourcePages, ...page } = candidate;
    return {
      ...page,
      ...(sourcePages ? { source_pages: sourcePages } : {}),
    };
  });
  return await structuredChatCompletion(
    "Consolidation response",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(CONSOLIDATE_PROMPT, schema),
    JSON.stringify({ candidates: providerCandidates }),
    {
      temperature: config.llm.consolidateTemperature,
      maxTokens: config.llm.consolidateMaxTokens,
      jsonMode: true,
      signal,
    },
    (content) => {
      const parsed = asRecord(
        parseJsonResponse(content, "Consolidation response"),
        "Consolidation response",
      );
      const notes = parseConsolidatedNotes(parsed.notes);
      return {
        summary: sourceSummary(notes),
        notes,
      };
    },
  );
}

async function extractChunks(
  chunks: string[],
  apiBase: string,
  apiKey: string,
  schema: string,
  signal?: AbortSignal,
): Promise<ExtractedItem[]> {
  const results = new Array<ExtractedItem[]>(chunks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      results[index] = await extractChunk(
        chunks[index],
        apiBase,
        apiKey,
        config.llm.extractModel,
        schema,
        signal,
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(EXTRACTION_CONCURRENCY, chunks.length) },
      () => worker(),
    ),
  );
  return results.flat();
}

// --- Main distil entry point: split → parallel extract → consolidate ---

export async function distil(
  transcript: string,
  apiBase: string,
  apiKey: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
  sourcePageCount?: number,
  signal?: AbortSignal,
): Promise<DistilResult> {
  const validatedSchema = validateWikiSchema(schema);
  const chunks = splitTranscript(
    transcript,
    config.ingest.maxChars,
    config.ingest.overlap,
  );
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(
      `Transcript requires ${chunks.length} chunks; maximum is ${MAX_CHUNKS}`,
    );
  }

  const candidates = await extractChunks(
    chunks,
    apiBase,
    apiKey,
    validatedSchema,
    signal,
  );
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `Extraction produced ${candidates.length} candidates; expected 1-${MAX_CANDIDATES}`,
    );
  }

  // Single consolidation pass with big model
  const result = await consolidateCandidates(
    candidates,
    apiBase,
    apiKey,
    config.llm.consolidateModel,
    validatedSchema,
    signal,
  );
  if (sourcePageCount === undefined) {
    return {
      ...result,
      notes: result.notes.map(({ sourcePages: _sourcePages, ...note }) => note),
    };
  }
  if (sourcePageCount !== undefined) {
    if (!Number.isSafeInteger(sourcePageCount) || sourcePageCount < 1) {
      throw new Error("PDF source page count is invalid");
    }
    for (const note of result.notes) {
      if (
        !note.sourcePages?.length ||
        note.sourcePages.some((page) => page > sourcePageCount)
      ) {
        throw new Error(
          `PDF page provenance for "${note.title}" is missing or out of range`,
        );
      }
    }
  }
  return result;
}

// --- Markdown rendering (unchanged) ---

export function noteToMarkdown(
  note: DistilNote,
  sourceUrl: string,
  sourceTitle: string,
): string {
  const frontmatter = [
    "---",
    `source: "${sourceTitle}"`,
    sourceUrl ? `url: "${sourceUrl}"` : null,
    `tags: [${note.tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
  ].filter(Boolean).join("\n");

  return `${frontmatter}\n\n# ${note.title}\n\n${note.body}\n`;
}

// --- Integration (small model) ---

const INTEGRATE_PROMPT =
  `You are a knowledge base integrator. You will receive a JSON object with "new_notes" and "existing_notes" arrays. For each new note, decide:

- "new": the note covers a topic not already in the wiki
- "merge": the note is a refinement/addition to an existing note — provide the existing note's id
- "contradict": the note contradicts or challenges an existing note — provide the existing note's id

Compare meaning, aliases, abbreviations, and plausible spelling or transcription variants, not only exact titles. Choose "merge" when the supplied text clearly describes the same durable subject. Do not create a near-duplicate because of a minor naming variation, and do not merge distinct subjects merely because their names are similar. Preserve genuine factual disagreement with "contradict".

Every new note includes an "incoming_index". Copy that exact index into its decision. You MUST respond with ONLY a JSON object (no markdown fences, no commentary). The format is:

{"decisions": [{"incoming_index": 0, "action": "new"}, {"incoming_index": 1, "action": "merge", "existing_id": 42}, {"incoming_index": 2, "action": "contradict", "existing_id": 17}]}

Return exactly one decision for every incoming_index. Never omit, duplicate, or invent an incoming_index.`;

export interface IntegrationDecision {
  action: "new" | "merge" | "contradict";
  existing_id?: number;
}

function normalisedTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("en-GB").match(
    /[\p{L}\p{N}]+/gu,
  ) ?? [];
}

function setSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection++;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function characterGrams(value: string): string[] {
  const normalised = normalisedTokens(value).join(" ");
  if (normalised.length < 3) return normalised ? [normalised] : [];
  return Array.from(
    { length: normalised.length - 2 },
    (_, index) => normalised.slice(index, index + 3),
  );
}

function titleSimilarity(left: string, right: string): number {
  const leftKey = normalisedTokens(left).join(" ");
  const rightKey = normalisedTokens(right).join(" ");
  if (leftKey === rightKey) return 1;
  const leftGrams = new Set(characterGrams(left));
  const rightGrams = new Set(characterGrams(right));
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared++;
  }
  return (2 * shared) / (leftGrams.size + rightGrams.size);
}

function normalisedNumbers(value: string): Set<string> {
  return new Set(
    Array.from(value.matchAll(/[-+]?\d[\d,]*(?:\.\d+)?%?/g), (match) => {
      const raw = match[0].replaceAll(",", "");
      const percent = raw.endsWith("%");
      const number = Number(percent ? raw.slice(0, -1) : raw);
      return Number.isFinite(number) ? `${number}${percent ? "%" : ""}` : raw;
    }),
  );
}

function hasNumericConflict(existingBody: string, incomingBody: string) {
  const existingNumbers = normalisedNumbers(existingBody);
  const incomingNumbers = normalisedNumbers(incomingBody);
  if (existingNumbers.size === 0 || incomingNumbers.size === 0) return false;
  const changed = [...incomingNumbers].some((value) =>
    !existingNumbers.has(value)
  );
  if (!changed) return false;

  const correctionLanguage =
    /\b(?:correct(?:ed|ion)?|revis(?:ed|ion)|updated?|supersed(?:e|es|ed|ing)|rather than|instead of|previously reported|no longer)\b/i;
  if (correctionLanguage.test(incomingBody)) return true;

  const maskNumbers = (value: string) =>
    value.replace(/[-+]?\d[\d,]*(?:\.\d+)?%?/g, " number ");
  return setSimilarity(
    normalisedTokens(maskNumbers(existingBody)),
    normalisedTokens(maskNumbers(incomingBody)),
  ) >= 0.72;
}

function strongestDuplicateMatch(
  incoming: DistilNote,
  existingNotes: Array<{ id: number; title: string; body?: string }>,
): { id: number; body?: string; score: number } | undefined {
  const matches = existingNotes.flatMap((existing) => {
    const titles = titleSimilarity(incoming.title, existing.title);
    const bodies = existing.body
      ? setSimilarity(
        normalisedTokens(incoming.body),
        normalisedTokens(existing.body),
      )
      : 0;
    const score = titles === 1
      ? 4
      : titles >= 0.88
      ? 3 + titles
      : bodies >= 0.88
      ? 2 + bodies
      : 0;
    return score > 0 ? [{ ...existing, score }] : [];
  }).sort((left, right) => right.score - left.score || left.id - right.id);

  if (matches.length === 0) return undefined;
  if (
    matches[0].score < 4 && matches[1] &&
    matches[0].score - matches[1].score < 0.08
  ) {
    return undefined;
  }
  return matches[0];
}

function safeguardIntegrationDecisions(
  newNotes: DistilNote[],
  existingNotes: Array<{ id: number; title: string; body?: string }>,
  decisions: IntegrationDecision[],
): IntegrationDecision[] {
  const existingById = new Map(existingNotes.map((note) => [note.id, note]));
  return decisions.map((decision, index) => {
    const incoming = newNotes[index];
    const duplicate = strongestDuplicateMatch(incoming, existingNotes);
    const target = duplicate ??
      (decision.existing_id === undefined
        ? undefined
        : existingById.get(decision.existing_id));
    if (!target) return decision;

    const contradicts = target.body !== undefined &&
      hasNumericConflict(target.body, incoming.body);
    if (duplicate) {
      return {
        action: contradicts || decision.action === "contradict"
          ? "contradict"
          : "merge",
        existing_id: duplicate.id,
      };
    }
    return contradicts && decision.action === "merge"
      ? { action: "contradict", existing_id: target.id }
      : decision;
  });
}

function parseIntegrationDecisions(
  value: unknown,
  expectedCount: number,
  existingIds: Set<number>,
  allowIncompleteFallback: boolean,
): IntegrationDecision[] {
  if (!Array.isArray(value)) {
    throw new Error("Integration response.decisions must be an array");
  }
  const parsed = value.map((item, responseIndex) => {
    const decision = asRecord(
      item,
      `Integration response.decisions[${responseIndex}]`,
    );
    if (
      decision.action !== "new" && decision.action !== "merge" &&
      decision.action !== "contradict"
    ) {
      throw new Error(
        `Integration response.decisions[${responseIndex}].action is invalid`,
      );
    }
    let integration: IntegrationDecision;
    if (decision.action === "new") {
      if (decision.existing_id !== undefined) {
        throw new Error(
          `Integration response.decisions[${responseIndex}] must not include existing_id for action new`,
        );
      }
      integration = { action: "new" };
    } else {
      if (
        !Number.isSafeInteger(decision.existing_id) ||
        !existingIds.has(decision.existing_id as number)
      ) {
        throw new Error(
          `Integration response.decisions[${responseIndex}].existing_id is not a supplied note ID`,
        );
      }
      integration = {
        action: decision.action,
        existing_id: decision.existing_id as number,
      };
    }
    return { incomingIndex: decision.incoming_index, integration };
  });

  const includesIndexes = parsed.some((decision) =>
    decision.incomingIndex !== undefined
  );
  if (!includesIndexes) {
    if (parsed.length === expectedCount) {
      return parsed.map((decision) => decision.integration);
    }
    if (
      !allowIncompleteFallback || parsed.length === 0 ||
      parsed.length > expectedCount
    ) {
      throw new Error(
        `Integration response returned ${parsed.length} decisions; expected ${expectedCount}`,
      );
    }
    // Without indexes, an omission makes every positional mapping ambiguous.
    // Default all candidates to new; deterministic safeguards still merge
    // strong duplicates and preserve numeric contradictions.
    return Array.from(
      { length: expectedCount },
      (): IntegrationDecision => ({ action: "new" }),
    );
  }

  const ordered: Array<IntegrationDecision | undefined> = Array(expectedCount);
  for (let responseIndex = 0; responseIndex < parsed.length; responseIndex++) {
    const { incomingIndex, integration } = parsed[responseIndex];
    if (
      !Number.isSafeInteger(incomingIndex) || Number(incomingIndex) < 0 ||
      Number(incomingIndex) >= expectedCount
    ) {
      throw new Error(
        `Integration response.decisions[${responseIndex}].incoming_index is invalid`,
      );
    }
    const index = Number(incomingIndex);
    if (ordered[index] !== undefined) {
      throw new Error(
        `Integration response contains duplicate incoming_index ${index}`,
      );
    }
    ordered[index] = integration;
  }
  const missing = Array.from(
    { length: expectedCount },
    (_, index) => index,
  ).filter((index) => ordered[index] === undefined);
  if (missing.length > 0 && !allowIncompleteFallback) {
    throw new Error(
      `Integration response omitted incoming_index ${missing.join(", ")}`,
    );
  }
  return Array.from(
    { length: expectedCount },
    (_, index) => ordered[index] ?? { action: "new" },
  );
}

function isRepeatedMalformedIntegrationJson(error: unknown): boolean {
  return error instanceof LlmServiceError &&
    error.message.startsWith(
      "Integration response was invalid after one retry:",
    ) && error.cause instanceof LlmServiceError &&
    error.cause.message === "Integration response was not valid JSON";
}

export async function integrate(
  newNotes: DistilNote[],
  existingNotes: Array<{ id: number; title: string; body?: string }>,
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
  signal?: AbortSignal,
): Promise<IntegrationDecision[]> {
  if (existingNotes.length === 0) {
    return newNotes.map(() => ({ action: "new" as const }));
  }

  const userContent = JSON.stringify({
    new_notes: newNotes.map((n, incomingIndex) => ({
      incoming_index: incomingIndex,
      title: n.title,
      type: n.type,
      body: n.body.slice(0, 1_200),
      links: n.links,
    })),
    existing_notes: existingNotes.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body?.slice(0, 1_200),
    })),
  });

  const existingIds = new Set(existingNotes.map((note) => note.id));
  let parseAttempts = 0;
  let decisions: IntegrationDecision[];
  try {
    decisions = await structuredChatCompletion(
      "Integration response",
      apiBase,
      apiKey,
      model,
      promptWithWikiSchema(INTEGRATE_PROMPT, schema),
      userContent,
      {
        temperature: config.llm.integrateTemperature,
        maxTokens: config.llm.integrateMaxTokens,
        jsonMode: true,
        signal,
      },
      (content) => {
        parseAttempts++;
        const parsed = asRecord(
          parseJsonResponse(content, "Integration response"),
          "Integration response",
        );
        return parseIntegrationDecisions(
          parsed.decisions,
          newNotes.length,
          existingIds,
          parseAttempts > 1,
        );
      },
    );
  } catch (error) {
    if (!isRepeatedMalformedIntegrationJson(error)) throw error;
    decisions = Array.from(
      { length: newNotes.length },
      (): IntegrationDecision => ({ action: "new" }),
    );
  }
  return safeguardIntegrationDecisions(newNotes, existingNotes, decisions);
}

// --- Note rewriting (big model) ---

const REWRITE_NOTE_PROMPT = `You are maintaining a knowledge wiki.

You will receive:
- an existing validated wiki page
- one or more new validated wiki pages from the same source
- an action: "merge" or "contradict"

Rewrite only the factual body of the existing page so it stays clean, coherent,
and self-contained. Synthesis owns the page title, type, tags, links,
frontmatter, Related section, and Sources section.

Rules:
- Integrate every new page's supported information naturally into the body.
- Do not just append a note at the end.
- Preserve every explicit quantity, threshold, date, population, qualifier,
  exception, uncertainty statement, and attribution from both bodies unless the
  new page explicitly corrects or supersedes it.
- When a new page explicitly corrects a fact, make the old and new values and
  the superseding relationship clear. Do not continue to present the old value
  as current.
- If action is "contradict", state the disagreement inline using cautious
  language; do not silently choose a side.
- Do not infer causality, recommendations, mechanisms, or general conclusions
  that the supplied pages do not explicitly support.
- Keep the result concise and readable.
- Do not include YAML frontmatter, a title heading, a Related section, a Sources
  section, source markers, tags, or wiki links.

Respond with ONLY JSON, no markdown fences:
{"body":"..."}`;

function mergePageValues(
  existing: string[],
  incoming: string[],
  maxItems: number,
): string[] {
  const merged = new Map<string, string>();
  for (const value of [...existing, ...incoming]) {
    const key = value.toLocaleLowerCase("en-GB");
    if (!merged.has(key)) merged.set(key, value);
  }
  return [...merged.values()].slice(0, maxItems);
}

export async function rewriteNote(
  existingPage: WikiPage,
  newPages: DistilNote[],
  action: "merge" | "contradict",
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
  signal?: AbortSignal,
): Promise<WikiPage> {
  const existing = validateWikiPage(existingPage);
  if (newPages.length === 0) {
    throw new Error("Wiki page rewrite requires at least one incoming page");
  }
  const incoming = newPages.map((page) => validateWikiPage(page));
  const tags = mergePageValues(
    existing.tags,
    incoming.flatMap((page) => page.tags),
    12,
  );
  const links = mergePageValues(
    existing.links,
    incoming.flatMap((page) => page.links),
    50,
  );

  return await structuredChatCompletion(
    "Wiki page rewrite",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(REWRITE_NOTE_PROMPT, schema),
    JSON.stringify({
      action,
      existing_page: existing,
      new_pages: incoming,
    }),
    {
      temperature: config.llm.temperature,
      maxTokens: config.llm.rewriteMaxTokens,
      jsonMode: true,
      signal,
    },
    (content) => {
      const parsed = asRecord(
        parseJsonResponse(content, "Wiki page rewrite"),
        "Wiki page rewrite",
      );
      return validateWikiPage({
        title: existing.title,
        type: existing.type,
        body: parsed.body,
        tags,
        links,
      });
    },
  );
}
