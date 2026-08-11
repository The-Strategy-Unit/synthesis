import { dirname } from "node:path";

import { config } from "./config.ts";
import type { DB, DiscoveryRecord, DiscoveryStatus } from "./db.ts";
import { parseJsonResponse, structuredChatCompletion } from "./llm.ts";
import { errMsg } from "./utils.ts";
import { parseWikiPage, renderWikiPage, validateWikiPage } from "./wiki.ts";
import { buildWikiGraph } from "./wiki_graph.ts";
import { DEFAULT_WIKI_SCHEMA, promptWithWikiSchema } from "./wiki_schema.ts";

const RELATIONSHIP_TYPES = new Set([
  "supports",
  "contradicts",
  "mechanistic",
  "causal_hypothesis",
  "temporal",
  "depends_on",
  "analogous",
  "shared_constraint",
  "research_gap",
]);
const MAX_CONTEXT_PAGES = 8;
const MAX_DISCOVERIES = 3;

const DISCOVERY_PROMPT =
  `You identify a small number of potentially useful, non-obvious connections among supplied compiled wiki pages.

Rules:
- Suggest only relationships supported by the supplied pages and source metadata.
- A discovery is a hypothesis for human review, not an established fact.
- Do not repeat a relationship already represented by explicit_links.
- Prefer useful, evidence-backed surprise over graph density.
- Preserve uncertainty and disagreement. Never turn confidence into evidential certainty.
- Cite 2-4 supplied page IDs and 1-8 supplied source IDs for every discovery.
- relationship_type must be one of: supports, contradicts, mechanistic, causal_hypothesis, temporal, depends_on, analogous, shared_constraint, research_gap.
- Return at most 3 discoveries. Return an empty array when no worthwhile connection is supported.

Respond with ONLY JSON:
{"discoveries":[{"relationship_type":"mechanistic","explanation":"...","significance":"...","page_ids":[1,2],"source_ids":[3,4],"confidence":0.72}]}`;

export interface DiscoveryView {
  id: number;
  status: DiscoveryStatus;
  relationshipType: string;
  explanation: string;
  significance: string;
  pages: Array<{ id: number; title: string }>;
  sources: Array<{
    id: number;
    title: string;
    sourceUrl: string | null;
  }>;
  productionMethod: string;
  model: string;
  confidence: number;
  createdAt: string;
  reviewedAt: string | null;
}

interface ValidatedSuggestion {
  relationshipType: string;
  explanation: string;
  significance: string;
  pageIds: number[];
  sourceIds: number[];
  confidence: number;
}

export class DiscoveryNotFoundError extends Error {}
export class DiscoveryStateError extends Error {}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${context} must not be empty`);
  if (text.length > maxLength) {
    throw new Error(`${context} exceeds ${maxLength} characters`);
  }
  if (/\p{Cc}/u.test(text)) {
    throw new Error(`${context} must not contain control characters`);
  }
  return text;
}

function idArray(
  value: unknown,
  context: string,
  min: number,
  max: number,
  allowed: ReadonlySet<number>,
): number[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${context} must contain ${min}-${max} IDs`);
  }
  const ids = [
    ...new Set(value.map((id) => {
      if (
        !Number.isSafeInteger(id) || Number(id) < 1 || !allowed.has(Number(id))
      ) {
        throw new Error(`${context} contains an ID that was not supplied`);
      }
      return Number(id);
    })),
  ];
  if (ids.length < min) throw new Error(`${context} contains duplicate IDs`);
  return ids.sort((left, right) => left - right);
}

function storedIds(
  value: string,
  context: string,
  min: number,
  max: number,
): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context} is invalid JSON`);
  }
  const allowed = new Set(
    Array.isArray(parsed)
      ? parsed.filter((id) => Number.isSafeInteger(id) && Number(id) > 0)
        .map(Number)
      : [],
  );
  return idArray(parsed, context, min, max, allowed);
}

function discoveryView(db: DB, record: DiscoveryRecord): DiscoveryView {
  const pageIds = storedIds(record.page_ids_json, "Discovery page IDs", 2, 4);
  const sourceIds = storedIds(
    record.source_ids_json,
    "Discovery source IDs",
    1,
    8,
  );
  const pages = pageIds.map((id) => {
    const note = db.getNote(id);
    if (!note) throw new Error(`Discovery ${record.id} page ${id} is missing`);
    return { id: note.id, title: note.title };
  });
  const sources = sourceIds.map((id) => {
    const source = db.getSource(id);
    if (!source) {
      throw new Error(`Discovery ${record.id} source ${id} is missing`);
    }
    return { id: source.id, title: source.title, sourceUrl: source.source_url };
  });
  if (!RELATIONSHIP_TYPES.has(record.relationship_type)) {
    throw new Error(`Discovery ${record.id} relationship type is invalid`);
  }
  if (
    !Number.isFinite(record.confidence) || record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error(`Discovery ${record.id} confidence is invalid`);
  }
  return {
    id: record.id,
    status: record.status,
    relationshipType: record.relationship_type,
    explanation: requiredText(
      record.explanation,
      "Discovery explanation",
      1_000,
    ),
    significance: requiredText(
      record.significance,
      "Discovery significance",
      1_000,
    ),
    pages,
    sources,
    productionMethod: requiredText(
      record.production_method,
      "Discovery production method",
      100,
    ),
    model: requiredText(record.model, "Discovery model", 200),
    confidence: record.confidence,
    createdAt: record.created_at,
    reviewedAt: record.reviewed_at,
  };
}

export function getDiscoveryView(db: DB, id: number): DiscoveryView {
  const record = db.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  return discoveryView(db, record);
}

export function listDiscoveryViews(
  db: DB,
  status?: DiscoveryStatus,
): DiscoveryView[] {
  return db.getDiscoveries(status).map((record) => discoveryView(db, record));
}

async function discoveryContextIds(
  db: DB,
  seedIds: number[],
): Promise<number[]> {
  const validSeeds = [...new Set(seedIds)].filter((id) => db.getNote(id));
  const graph = await buildWikiGraph(db);
  const neighbors: number[] = [];
  for (const seedId of validSeeds) {
    for (const link of graph.links) {
      if (link.source === seedId) neighbors.push(link.target);
      else if (link.target === seedId) neighbors.push(link.source);
    }
  }
  return [
    ...new Set([
      ...validSeeds,
      ...neighbors,
      ...db.getAllNotes().map((note) => note.id),
    ]),
  ].slice(0, MAX_CONTEXT_PAGES);
}

function explicitPairKeys(
  links: Awaited<ReturnType<typeof buildWikiGraph>>["links"],
): Set<string> {
  return new Set(
    links.filter((link) => link.kind === "explicit").map((link) =>
      `${Math.min(link.source, link.target)}:${
        Math.max(link.source, link.target)
      }`
    ),
  );
}

function suggestionFingerprint(suggestion: ValidatedSuggestion): string {
  return `${suggestion.relationshipType}|${suggestion.pageIds.join(",")}|${
    suggestion.sourceIds.join(",")
  }`;
}

export async function generateDiscoveries(
  db: DB,
  seedIds: number[],
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
): Promise<DiscoveryView[]> {
  const pageIds = await discoveryContextIds(db, seedIds);
  if (pageIds.length < 2) return [];
  const pages = [];
  for (const id of pageIds) {
    const note = db.getNote(id);
    if (!note) continue;
    try {
      const content = await Deno.readTextFile(note.file_path);
      parseWikiPage(content);
      pages.push({ id, title: note.title, content: content.slice(0, 8_000) });
    } catch {
      // Wiki health reports unreadable or legacy pages separately.
    }
  }
  if (pages.length < 2) return [];
  const suppliedPageIds = new Set(pages.map((page) => page.id));
  const sources = db.getSourcesForNotes([...suppliedPageIds]).map((source) => ({
    id: source.id,
    title: source.title,
    summary: source.summary,
  }));
  if (sources.length === 0) return [];
  const graph = await buildWikiGraph(db);
  const explicitPairs = explicitPairKeys(graph.links);
  const explicitLinks = graph.links.filter((link) => link.kind === "explicit")
    .map((link) => ({ source: link.source, target: link.target }));

  const suggestions = await structuredChatCompletion(
    "Discovery response",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(DISCOVERY_PROMPT, schema),
    JSON.stringify({
      pages,
      sources,
      explicit_links: explicitLinks,
    }),
    {
      temperature: 0.2,
      maxTokens: Math.max(config.llm.maxTokens, 2_000),
      jsonMode: true,
    },
    (content) => {
      const parsed = asRecord(
        parseJsonResponse(content, "Discovery response"),
        "Discovery response",
      );
      if (
        !Array.isArray(parsed.discoveries) ||
        parsed.discoveries.length > MAX_DISCOVERIES
      ) {
        throw new Error(
          "Discovery response.discoveries must contain at most 3 items",
        );
      }

      const suggestions: ValidatedSuggestion[] = [];
      for (let index = 0; index < parsed.discoveries.length; index++) {
        const item = asRecord(
          parsed.discoveries[index],
          `Discovery response.discoveries[${index}]`,
        );
        const relationshipType = requiredText(
          item.relationship_type,
          `Discovery response.discoveries[${index}].relationship_type`,
          40,
        );
        if (!RELATIONSHIP_TYPES.has(relationshipType)) {
          throw new Error(
            `Discovery ${index} relationship type is not supported`,
          );
        }
        const pageIds = idArray(
          item.page_ids,
          `Discovery response.discoveries[${index}].page_ids`,
          2,
          4,
          suppliedPageIds,
        );
        const citedSources = db.getSourcesForNotes(pageIds);
        const sourceIds = idArray(
          item.source_ids,
          `Discovery response.discoveries[${index}].source_ids`,
          1,
          8,
          new Set(citedSources.map((source) => source.id)),
        );
        const allPairsExplicit = pageIds.every((left, leftIndex) =>
          pageIds.slice(leftIndex + 1).every((right) =>
            explicitPairs.has(
              `${Math.min(left, right)}:${Math.max(left, right)}`,
            )
          )
        );
        if (allPairsExplicit) continue;
        if (
          typeof item.confidence !== "number" ||
          !Number.isFinite(item.confidence) || item.confidence < 0 ||
          item.confidence > 1
        ) {
          throw new Error(
            `Discovery ${index} confidence must be between 0 and 1`,
          );
        }
        suggestions.push({
          relationshipType,
          explanation: requiredText(
            item.explanation,
            `Discovery response.discoveries[${index}].explanation`,
            1_000,
          ),
          significance: requiredText(
            item.significance,
            `Discovery response.discoveries[${index}].significance`,
            1_000,
          ),
          pageIds,
          sourceIds,
          confidence: item.confidence,
        });
      }
      return suggestions;
    },
  );

  const insertedIds: number[] = [];
  for (const suggestion of suggestions) {
    const id = db.addDiscovery({
      fingerprint: suggestionFingerprint(suggestion),
      relationship_type: suggestion.relationshipType,
      explanation: suggestion.explanation,
      significance: suggestion.significance,
      page_ids_json: JSON.stringify(suggestion.pageIds),
      source_ids_json: JSON.stringify(suggestion.sourceIds),
      production_method: "llm_graph_review",
      model,
      confidence: suggestion.confidence,
    });
    if (id !== undefined) insertedIds.push(id);
  }
  return insertedIds.map((id) => getDiscoveryView(db, id));
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  const tempPath = await Deno.makeTempFile({
    dir: dirname(filePath),
    prefix: ".synthesis-discovery-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(tempPath, content);
    await Deno.rename(tempPath, filePath);
  } catch (error) {
    try {
      await Deno.remove(tempPath);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) {
        console.error(`Discovery cleanup failed: ${errMsg(cleanupError)}`);
      }
    }
    throw error;
  }
}

function renderWithExistingSources(markdown: string, links: string[]): string {
  const page = parseWikiPage(markdown);
  const rendered = renderWikiPage(validateWikiPage({ ...page, links }), []);
  const sourceLines = markdown.split("\n").filter((line) =>
    /<!-- synthesis-source:[a-f0-9]{64} -->/.test(line)
  );
  const result = sourceLines.length === 0
    ? rendered
    : `${rendered.trimEnd()}\n\n## Sources\n\n${sourceLines.join("\n")}\n`;
  parseWikiPage(result);
  return result;
}

export async function confirmDiscovery(
  db: DB,
  id: number,
): Promise<DiscoveryView> {
  const record = db.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  if (!["pending", "investigating"].includes(record.status)) {
    throw new DiscoveryStateError(
      `Discovery ${id} is already ${record.status}`,
    );
  }
  const view = discoveryView(db, record);
  const graph = await buildWikiGraph(db);
  const explicitPairs = explicitPairKeys(graph.links);
  let pair: [number, number] | undefined;
  for (let leftIndex = 0; leftIndex < view.pages.length && !pair; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < view.pages.length;
      rightIndex++
    ) {
      const left = view.pages[leftIndex].id;
      const right = view.pages[rightIndex].id;
      if (
        !explicitPairs.has(`${Math.min(left, right)}:${Math.max(left, right)}`)
      ) {
        pair = [left, right];
        break;
      }
    }
  }

  let original: string | undefined;
  let sourcePath: string | undefined;
  if (pair) {
    const source = db.getNote(pair[0]);
    const target = db.getNote(pair[1]);
    if (!source || !target) throw new Error(`Discovery ${id} page is missing`);
    sourcePath = source.file_path;
    original = await Deno.readTextFile(sourcePath);
    const page = parseWikiPage(original);
    const links = [...page.links, target.title];
    await replaceFile(sourcePath, renderWithExistingSources(original, links));
  }

  try {
    if (!db.reviewDiscovery(id, "confirmed")) {
      throw new DiscoveryStateError(`Discovery ${id} is no longer reviewable`);
    }
  } catch (error) {
    if (original !== undefined && sourcePath !== undefined) {
      await replaceFile(sourcePath, original);
    }
    throw error;
  }
  return getDiscoveryView(db, id);
}

export function reviewDiscovery(
  db: DB,
  id: number,
  status: "investigating" | "rejected",
): DiscoveryView {
  const record = db.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  if (!db.reviewDiscovery(id, status)) {
    throw new DiscoveryStateError(
      `Discovery ${id} is already ${record.status}`,
    );
  }
  return getDiscoveryView(db, id);
}
