import { dirname } from "node:path";

import { config } from "../app/config.ts";
import type {
  DB,
  DiscoveryCandidateInput,
  DiscoveryCandidateRecord,
  DiscoveryRecord,
  DiscoveryStatus,
} from "../catalogue/db.ts";
import {
  parseJsonResponse,
  structuredChatCompletion,
} from "../provider/llm.ts";
import { errMsg } from "../shared/utils.ts";
import {
  parseWikiPage,
  renderWikiPage,
  validateWikiPage,
  type WikiRelationship,
} from "./wiki.ts";
import { buildWikiGraph } from "./wiki_graph.ts";
import { DEFAULT_WIKI_SCHEMA, promptWithWikiSchema } from "./wiki_schema.ts";

const RELATIONSHIP_TYPES = new Set([
  "consolidation_candidate",
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
const MAX_CANDIDATES_PER_BATCH = 5;
const MAX_SEEDED_CANDIDATES = 5;
const MAX_VAULT_CANDIDATES = 20;
const MAX_NEAREST_PER_PAGE = 64;
const MAX_CROSS_SOURCE_NEIGHBORS_PER_PAGE = 8;
const MAX_DISCOVERY_SOURCE_IDS = 4_096;
const MAX_PROMPT_SOURCES_PER_PAGE = 4;
const MIN_SEMANTIC_CANDIDATE = 0.5;
const MIN_LEXICAL_CANDIDATE = 0.12;
const DISCOVERY_PROMPT_VERSION = "cross-source-v3";
export const MAX_DISCOVERY_BATCH_ITEMS = 500;

const CANDIDATE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

const DISCOVERY_PROMPT =
  `You review preselected pairs of compiled wiki pages from different sources and propose worthwhile cross-source synthesis.

Rules:
- Candidate pairs were selected by lexical or embedding similarity. Similarity is not evidence.
- Suggest only relationships supported by the supplied page text and source metadata.
- Every suggestion is a hypothesis for human review, not an established fact.
- Use "consolidation_candidate" only when both pages cover substantially the same durable concept and could be consolidated without erasing meaningful differences. Related pages are not necessarily duplicates.
- For other useful connections, relationship_type must be one of: supports, contradicts, mechanistic, causal_hypothesis, temporal, depends_on, analogous, shared_constraint, research_gap.
- Do not conflate similarly worded events, teams, organisations, populations, methods, or measures. Respect each source's identity and scope.
- Identify what each page actually states. Do not infer causality unless the supplied text supports it.
- Prefer useful, evidence-backed surprise over graph density.
- Preserve uncertainty and disagreement. Never turn confidence into evidential certainty.
- Copy the exact candidate_index for each suggestion. Never combine pages from different candidate pairs.
- Return at most one suggestion per candidate. Omit weak or merely topical similarities.

Respond with ONLY JSON:
{"discoveries":[{"candidate_index":0,"relationship_type":"mechanistic","explanation":"...","significance":"...","confidence":0.72}]}`;

export interface DiscoveryView {
  id: number;
  status: DiscoveryStatus;
  relationshipType: string;
  explanation: string;
  significance: string;
  pages: Array<{ id: number; title: string }>;
  pageHashes: string[];
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
  proposalKind: "consolidation" | "relationship";
}

export interface DiscoveryGenerationOptions {
  scope?: "seeded" | "vault";
  generation?: string;
  signal?: AbortSignal;
  onProgress?: (progress: {
    current: number;
    total: number;
    candidateCount: number;
    coverage: DiscoveryCoverage;
  }) => void;
}

export interface DiscoveryCoverage {
  generation: string | null;
  eligiblePages: number;
  candidates: number;
  evaluated: number;
  proposed: number;
  reviewedWithoutProposal: number;
  remaining: number;
  complete: boolean;
}

export interface DiscoveryGenerationResult {
  discoveries: DiscoveryView[];
  coverage: DiscoveryCoverage;
}

interface ValidatedSuggestion {
  candidateIndex: number;
  relationshipType: string;
  explanation: string;
  significance: string;
  pageIds: number[];
  pageHashes: string[];
  sourceIds: number[];
  confidence: number;
}

interface CandidatePage {
  id: number;
  title: string;
  type: string;
  body: string;
  sourceIds: number[];
  contentHash: string;
}

interface CandidatePair {
  key: string;
  left: CandidatePage;
  right: CandidatePage;
  sourceIds: number[];
  score: number;
  semanticSimilarity?: number;
  lexicalSimilarity: number;
}

export class DiscoveryNotFoundError extends Error {}
export class DiscoveryStateError extends Error {}
export class DiscoveryBatchInputError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_DISCOVERY_BATCH"
      | "CONFIRMATION_REQUIRED" = "INVALID_DISCOVERY_BATCH",
  ) {
    super(message);
  }
}

export type DiscoveryBatchAction = "confirm" | "reject";

export interface ValidatedDiscoveryBatch {
  action: DiscoveryBatchAction;
  ids: number[];
}

export interface DiscoveryBatchResult {
  action: DiscoveryBatchAction;
  reviewed: DiscoveryView[];
  linksAdded: number;
}

export function discoveryBatchConfirmation(
  action: DiscoveryBatchAction,
  count: number,
): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("Discovery batch count must be positive");
  }
  return action === "confirm"
    ? `CONFIRM ${count} LINKS`
    : `REJECT ${count} PROPOSALS`;
}

export function validateDiscoveryBatchRequest(
  value: unknown,
  maxItems = MAX_DISCOVERY_BATCH_ITEMS,
): ValidatedDiscoveryBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscoveryBatchInputError(
      "Discovery batch request must be an object",
    );
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError("Discovery batch limit must be positive");
  }
  const request = value as Record<string, unknown>;
  if (request.action !== "confirm" && request.action !== "reject") {
    throw new DiscoveryBatchInputError(
      "Discovery batch action must be 'confirm' or 'reject'",
    );
  }
  if (
    !Array.isArray(request.ids) || request.ids.length < 1 ||
    request.ids.length > maxItems
  ) {
    throw new DiscoveryBatchInputError(
      `Discovery batch must contain 1-${maxItems} IDs`,
    );
  }
  const ids = request.ids.map((id) => Number(id));
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  ) {
    throw new DiscoveryBatchInputError(
      "Discovery batch IDs must be unique positive integers",
    );
  }
  const action = request.action;
  const expected = discoveryBatchConfirmation(action, ids.length);
  if (request.confirm !== expected) {
    throw new DiscoveryBatchInputError(
      `Set 'confirm' to '${expected}' to review this exact batch`,
      "CONFIRMATION_REQUIRED",
    );
  }
  return { action, ids };
}

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

function storedHashes(
  value: string,
  context: string,
  count: number,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context} is invalid JSON`);
  }
  if (
    !Array.isArray(parsed) || parsed.length !== count ||
    parsed.some((hash) =>
      typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
    )
  ) {
    throw new Error(`${context} must contain ${count} SHA-256 hashes`);
  }
  return parsed as string[];
}

function discoveryView(db: DB, record: DiscoveryRecord): DiscoveryView {
  const pageIds = storedIds(record.page_ids_json, "Discovery page IDs", 2, 4);
  const sourceIds = storedIds(
    record.source_ids_json,
    "Discovery source IDs",
    1,
    MAX_DISCOVERY_SOURCE_IDS,
  );
  const pages = pageIds.map((id) => {
    const note = db.notes.getNote(id);
    if (!note) throw new Error(`Discovery ${record.id} page ${id} is missing`);
    return { id: note.id, title: note.title };
  });
  let pageHashes: string[] = [];
  try {
    pageHashes = storedHashes(
      record.page_hashes_json,
      `Discovery ${record.id} page hashes`,
      pageIds.length,
    );
  } catch {
    // Legacy proposals remain inspectable but cannot be confirmed.
  }
  const sources = sourceIds.map((id) => {
    const source = db.sources.getSource(id);
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
    pageHashes,
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
    proposalKind: record.relationship_type === "consolidation_candidate"
      ? "consolidation"
      : "relationship",
  };
}

export function getDiscoveryView(db: DB, id: number): DiscoveryView {
  const record = db.discoveries.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  return discoveryView(db, record);
}

export function listDiscoveryViews(
  db: DB,
  status?: DiscoveryStatus,
): DiscoveryView[] {
  return db.discoveries.getDiscoveries(status).map((record) =>
    discoveryView(db, record)
  );
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

function pairKey(left: number, right: number): string {
  return `${Math.min(left, right)}:${Math.max(left, right)}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function discoveryEvidenceHash(
  page: { title: string; type: string; body: string },
  sourceIds: number[],
): Promise<string> {
  return await sha256(JSON.stringify({
    title: page.title,
    type: page.type,
    body: page.body,
    sourceIds: [...sourceIds].sort((left, right) => left - right),
  }));
}

async function candidateFingerprint(
  pair: CandidatePair,
  model: string,
): Promise<string> {
  return await sha256(JSON.stringify({
    promptVersion: DISCOVERY_PROMPT_VERSION,
    model,
    left: [pair.left.id, pair.left.contentHash],
    right: [pair.right.id, pair.right.contentHash],
  }));
}

function tokenSet(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase("en-GB").match(
      /[\p{L}\p{N}]+/gu,
    ) ?? []).filter((token) =>
      token.length >= 2 && !CANDIDATE_STOP_WORDS.has(token)
    ),
  );
}

function setSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function lexicalSimilarity(left: CandidatePage, right: CandidatePage): number {
  const title = setSimilarity(tokenSet(left.title), tokenSet(right.title));
  const body = setSimilarity(tokenSet(left.body), tokenSet(right.body));
  return Math.max(title, body * 0.65);
}

function sourceSetsOverlap(left: number[], right: number[]): boolean {
  const leftSet = new Set(left);
  return right.some((sourceId) => leftSet.has(sourceId));
}

function knownDiscoveryPairs(
  db: DB,
  pages: ReadonlyMap<number, CandidatePage>,
): Set<string> {
  const pairs = new Set<string>();
  for (const discovery of db.discoveries.getDiscoveries()) {
    const pageIds = storedIds(
      discovery.page_ids_json,
      `Discovery ${discovery.id} page IDs`,
      2,
      4,
    );
    let pageHashes: string[];
    try {
      pageHashes = storedHashes(
        discovery.page_hashes_json,
        `Discovery ${discovery.id} page hashes`,
        pageIds.length,
      );
    } catch {
      continue;
    }
    if (
      pageIds.some((id, index) =>
        pages.get(id)?.contentHash !== pageHashes[index]
      )
    ) continue;
    for (let left = 0; left < pageIds.length; left++) {
      for (let right = left + 1; right < pageIds.length; right++) {
        pairs.add(pairKey(pageIds[left], pageIds[right]));
      }
    }
  }
  return pairs;
}

async function candidatePage(
  db: DB,
  note: { id: number; title: string; file_path: string },
): Promise<CandidatePage | null> {
  try {
    const page = parseWikiPage(await Deno.readTextFile(note.file_path));
    const sourceIds = db.sources.getSourceProvenanceForNote(note.id).map((
      source,
    ) => source.id).sort((left, right) => left - right);
    if (sourceIds.length === 0) return null;
    const contentHash = await discoveryEvidenceHash(page, sourceIds);
    return {
      id: note.id,
      title: note.title,
      type: page.type,
      body: page.body,
      sourceIds,
      contentHash,
    };
  } catch {
    // Wiki health reports unreadable or legacy pages separately.
    return null;
  }
}

async function candidatePages(db: DB): Promise<Map<number, CandidatePage>> {
  const pages = new Map<number, CandidatePage>();
  for (const note of db.notes.getAllNotes()) {
    const page = await candidatePage(db, note);
    if (page) pages.set(note.id, page);
  }
  return pages;
}

async function crossSourceCandidates(
  db: DB,
  seedIds: number[],
  scope: "seeded" | "vault",
  pages: Map<number, CandidatePage>,
): Promise<CandidatePair[]> {
  const seeds = scope === "vault"
    ? [...pages.keys()]
    : [...new Set(seedIds)].filter((id) => pages.has(id));
  if (seeds.length === 0 || pages.size < 2) return [];

  const graph = await buildWikiGraph(db);
  const excludedPairs = new Set([
    ...explicitPairKeys(graph.links),
    ...knownDiscoveryPairs(db, pages),
  ]);
  const pairs = new Map<string, CandidatePair>();
  const addPair = (
    seed: CandidatePage,
    candidate: CandidatePage,
    semanticSimilarity?: number,
    allowWeak = false,
  ): boolean => {
    if (
      seed.id === candidate.id ||
      sourceSetsOverlap(seed.sourceIds, candidate.sourceIds)
    ) return false;
    const key = pairKey(seed.id, candidate.id);
    if (excludedPairs.has(key)) return false;
    const sourceIds = [
      ...new Set([
        ...seed.sourceIds,
        ...candidate.sourceIds,
      ]),
    ].sort((left, right) => left - right);
    const lexical = lexicalSimilarity(seed, candidate);
    if (
      !allowWeak &&
      (semanticSimilarity === undefined ||
        semanticSimilarity < MIN_SEMANTIC_CANDIDATE) &&
      lexical < MIN_LEXICAL_CANDIDATE
    ) return false;
    const boundedSemantic = semanticSimilarity === undefined
      ? undefined
      : Math.max(-1, Math.min(1, semanticSimilarity));
    const score = Math.min(1, Math.max(boundedSemantic ?? 0, lexical));
    const ordered = seed.id < candidate.id
      ? [seed, candidate] as const
      : [candidate, seed] as const;
    const pair: CandidatePair = {
      key,
      left: ordered[0],
      right: ordered[1],
      sourceIds,
      score,
      lexicalSimilarity: lexical,
      ...(boundedSemantic === undefined
        ? {}
        : { semanticSimilarity: boundedSemantic }),
    };
    const previous = pairs.get(key);
    if ((previous?.score ?? -1) < score) pairs.set(key, pair);
    return previous === undefined;
  };

  const nearestLimit = Math.min(
    pages.size,
    Math.max(config.link.k, MAX_NEAREST_PER_PAGE),
  );
  for (const seedId of seeds) {
    const seed = pages.get(seedId)!;
    const embedding = db.search.getEmbedding(seedId);
    if (embedding) {
      let added = 0;
      for (
        const nearest of db.search.findNearest(seedId, embedding, nearestLimit)
      ) {
        const candidate = pages.get(nearest.id);
        if (
          !candidate || sourceSetsOverlap(seed.sourceIds, candidate.sourceIds)
        ) {
          continue;
        }
        if (addPair(seed, candidate, nearest.similarity)) added++;
        if (added >= MAX_CROSS_SOURCE_NEIGHBORS_PER_PAGE) break;
      }
    }
    for (
      const match of db.search.findIntegrationCandidates(
        `${seed.title}\n${seed.body}`,
        16,
      )
    ) {
      const candidate = pages.get(match.id);
      if (candidate) addPair(seed, candidate);
    }
  }

  if (pairs.size === 0 && pages.size <= 24) {
    for (const seedId of seeds) {
      const seed = pages.get(seedId)!;
      for (const candidate of pages.values()) {
        addPair(seed, candidate, undefined, true);
      }
    }
  }

  return [...pairs.values()].sort((left, right) =>
    right.score - left.score || left.key.localeCompare(right.key)
  );
}

function suggestionFingerprint(suggestion: ValidatedSuggestion): string {
  return `${suggestion.relationshipType}|${
    suggestion.pageIds.map((id, index) =>
      `${id}:${suggestion.pageHashes[index]}`
    ).join("|")
  }`;
}

function discoveryCoverage(
  db: DB,
  generation: string | null,
  eligiblePages: number,
): DiscoveryCoverage {
  if (generation === null) {
    return {
      generation: null,
      eligiblePages,
      candidates: 0,
      evaluated: 0,
      proposed: 0,
      reviewedWithoutProposal: 0,
      remaining: 0,
      complete: true,
    };
  }
  const stored = db.discoveries.getDiscoveryCandidateCoverage(generation);
  return {
    generation,
    eligiblePages,
    candidates: stored.total,
    evaluated: stored.reviewed + stored.proposed,
    proposed: stored.proposed,
    reviewedWithoutProposal: stored.reviewed,
    remaining: stored.queued,
    complete: stored.queued === 0,
  };
}

function storedCandidatePair(
  record: DiscoveryCandidateRecord,
  pages: Map<number, CandidatePage>,
): CandidatePair | null {
  const left = pages.get(record.left_note_id);
  const right = pages.get(record.right_note_id);
  if (
    !left || !right || left.contentHash !== record.left_hash ||
    right.contentHash !== record.right_hash ||
    record.prompt_version !== DISCOVERY_PROMPT_VERSION
  ) return null;
  const sourceIds = [...new Set([...left.sourceIds, ...right.sourceIds])].sort(
    (first, second) => first - second,
  );
  if (
    sourceSetsOverlap(left.sourceIds, right.sourceIds)
  ) return null;
  return {
    key: pairKey(left.id, right.id),
    left,
    right,
    sourceIds,
    score: record.score,
    lexicalSimilarity: record.lexical_similarity,
    ...(record.semantic_similarity === null ? {} : {
      semanticSimilarity: record.semantic_similarity,
    }),
  };
}

async function stageCandidateGeneration(
  db: DB,
  candidates: CandidatePair[],
  model: string,
  scope: "seeded" | "vault",
  seedIds: number[],
  pageSnapshotHash: string,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const generation = crypto.randomUUID();
  const stored: DiscoveryCandidateInput[] = await Promise.all(
    candidates.map(async (candidate) => ({
      fingerprint: await candidateFingerprint(candidate, model),
      generation,
      left_note_id: candidate.left.id,
      right_note_id: candidate.right.id,
      left_hash: candidate.left.contentHash,
      right_hash: candidate.right.contentHash,
      prompt_version: DISCOVERY_PROMPT_VERSION,
      model,
      score: candidate.score,
      lexical_similarity: candidate.lexicalSimilarity,
      semantic_similarity: candidate.semanticSimilarity ?? null,
    })),
  );
  db.discoveries.addDiscoveryGeneration({
    generation,
    scope,
    seed_ids_json: JSON.stringify(seedIds),
    page_snapshot_hash: pageSnapshotHash,
    prompt_version: DISCOVERY_PROMPT_VERSION,
    model,
  });
  db.discoveries.stageDiscoveryCandidates(generation, stored);
  return generation;
}

async function discoveryPageSnapshot(
  pages: ReadonlyMap<number, CandidatePage>,
): Promise<string> {
  return await sha256(JSON.stringify(
    [...pages.values()].sort((left, right) => left.id - right.id).map((
      page,
    ) => [page.id, page.contentHash]),
  ));
}

export async function generateDiscoveries(
  db: DB,
  seedIds: number[],
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
  options: DiscoveryGenerationOptions = {},
): Promise<DiscoveryGenerationResult> {
  const scope = options.scope ?? "seeded";
  const pages = await candidatePages(db);
  const normalisedSeedIds = scope === "vault"
    ? []
    : [...new Set(seedIds)].filter((id) => pages.has(id)).sort((a, b) => a - b);
  const pageSnapshotHash = await discoveryPageSnapshot(pages);
  let generation = options.generation ?? null;
  if (generation !== null) {
    const manifest = db.discoveries.getDiscoveryGeneration(generation);
    let manifestSeeds: unknown;
    try {
      manifestSeeds = manifest ? JSON.parse(manifest.seed_ids_json) : null;
    } catch {
      manifestSeeds = null;
    }
    const storedCandidates = db.discoveries.getDiscoveryCandidates(generation);
    const canResume = manifest !== undefined &&
      manifest.scope === scope && manifest.model === model &&
      manifest.prompt_version === DISCOVERY_PROMPT_VERSION &&
      manifest.page_snapshot_hash === pageSnapshotHash &&
      JSON.stringify(manifestSeeds) === JSON.stringify(normalisedSeedIds) &&
      storedCandidates.length > 0 &&
      storedCandidates.every((candidate) =>
        candidate.model === model &&
        storedCandidatePair(candidate, pages) !== null
      );
    if (!canResume) {
      throw new DiscoveryStateError(
        "Discovery sweep scope or wiki evidence changed; start a new comparison",
      );
    }
  } else {
    const candidates = await crossSourceCandidates(db, seedIds, scope, pages);
    generation = await stageCandidateGeneration(
      db,
      candidates,
      model,
      scope,
      normalisedSeedIds,
      pageSnapshotHash,
    );
  }
  if (generation === null) {
    return {
      discoveries: [],
      coverage: discoveryCoverage(db, null, pages.size),
    };
  }

  const limit = scope === "vault"
    ? MAX_VAULT_CANDIDATES
    : MAX_SEEDED_CANDIDATES;
  const queuedRecords = db.discoveries.getDiscoveryCandidates(
    generation,
    "queued",
    limit,
  );
  const queued = queuedRecords.map((record) => {
    const pair = storedCandidatePair(record, pages);
    if (!pair || record.model !== model) {
      throw new Error("Discovery sweep is stale; start a new comparison");
    }
    return { record, pair };
  });
  if (queued.length === 0) {
    return {
      discoveries: [],
      coverage: discoveryCoverage(db, generation, pages.size),
    };
  }

  const insertedIds: number[] = [];
  const batches = Array.from(
    { length: Math.ceil(queued.length / MAX_CANDIDATES_PER_BATCH) },
    (_, index) =>
      queued.slice(
        index * MAX_CANDIDATES_PER_BATCH,
        (index + 1) * MAX_CANDIDATES_PER_BATCH,
      ),
  );
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    options.onProgress?.({
      current: batchIndex + 1,
      total: batches.length,
      candidateCount: batch.length,
      coverage: discoveryCoverage(db, generation, pages.size),
    });
    const promptSourceIds = [
      ...new Set(batch.flatMap(({ pair }) => [
        ...pair.left.sourceIds.slice(0, MAX_PROMPT_SOURCES_PER_PAGE),
        ...pair.right.sourceIds.slice(0, MAX_PROMPT_SOURCES_PER_PAGE),
      ])),
    ];
    const sources = promptSourceIds.map((id) => {
      const source = db.sources.getSource(id);
      if (!source) throw new Error(`Synthesis source ${id} is missing`);
      return {
        id: source.id,
        title: source.title,
        summary: source.summary.slice(0, 600),
      };
    });
    const suggestions = await structuredChatCompletion(
      "Discovery response",
      apiBase,
      apiKey,
      model,
      promptWithWikiSchema(DISCOVERY_PROMPT, schema),
      JSON.stringify({
        candidates: batch.map(({ pair }, candidateIndex) => ({
          candidate_index: candidateIndex,
          left: {
            id: pair.left.id,
            title: pair.left.title,
            type: pair.left.type,
            body: pair.left.body.slice(0, 1_400),
            source_ids: pair.left.sourceIds.slice(
              0,
              MAX_PROMPT_SOURCES_PER_PAGE,
            ),
          },
          right: {
            id: pair.right.id,
            title: pair.right.title,
            type: pair.right.type,
            body: pair.right.body.slice(0, 1_400),
            source_ids: pair.right.sourceIds.slice(
              0,
              MAX_PROMPT_SOURCES_PER_PAGE,
            ),
          },
          candidate_signals: {
            lexical_similarity: Number(
              pair.lexicalSimilarity.toFixed(4),
            ),
            ...(pair.semanticSimilarity === undefined ? {} : {
              embedding_similarity: Number(
                pair.semanticSimilarity.toFixed(4),
              ),
            }),
          },
        })),
        sources,
      }),
      {
        temperature: 0.1,
        maxTokens: Math.max(config.llm.maxTokens, 2_000),
        jsonMode: true,
        signal: options.signal,
      },
      (content) => {
        const parsed = asRecord(
          parseJsonResponse(content, "Discovery response"),
          "Discovery response",
        );
        if (
          !Array.isArray(parsed.discoveries) ||
          parsed.discoveries.length > batch.length
        ) {
          throw new Error(
            `Discovery response.discoveries must contain at most ${batch.length} items`,
          );
        }

        const suggestions: ValidatedSuggestion[] = [];
        const usedCandidates = new Set<number>();
        for (let index = 0; index < parsed.discoveries.length; index++) {
          const item = asRecord(
            parsed.discoveries[index],
            `Discovery response.discoveries[${index}]`,
          );
          if (
            !Number.isSafeInteger(item.candidate_index) ||
            Number(item.candidate_index) < 0 ||
            Number(item.candidate_index) >= batch.length
          ) {
            throw new Error(
              `Discovery response.discoveries[${index}].candidate_index is invalid`,
            );
          }
          const candidateIndex = Number(item.candidate_index);
          if (usedCandidates.has(candidateIndex)) {
            throw new Error(
              `Discovery response contains duplicate candidate_index ${candidateIndex}`,
            );
          }
          usedCandidates.add(candidateIndex);
          const candidate = batch[candidateIndex].pair;
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
            candidateIndex,
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
            pageIds: [candidate.left.id, candidate.right.id],
            pageHashes: [
              candidate.left.contentHash,
              candidate.right.contentHash,
            ],
            sourceIds: candidate.sourceIds,
            confidence: item.confidence,
          });
        }
        return suggestions;
      },
    );

    const suggestionsByCandidate = new Map(
      suggestions.map((suggestion) => [suggestion.candidateIndex, suggestion]),
    );
    db.withTransaction(() => {
      for (
        let candidateIndex = 0;
        candidateIndex < batch.length;
        candidateIndex++
      ) {
        const candidate = batch[candidateIndex];
        const suggestion = suggestionsByCandidate.get(candidateIndex);
        if (!suggestion) {
          if (
            !db.discoveries.reviewDiscoveryCandidate(
              generation,
              candidate.record.fingerprint,
              "reviewed",
              null,
            )
          ) {
            throw new Error("Discovery candidate review state changed");
          }
          continue;
        }
        const fingerprint = suggestionFingerprint(suggestion);
        const insertedId = db.discoveries.addDiscovery({
          fingerprint,
          relationship_type: suggestion.relationshipType,
          explanation: suggestion.explanation,
          significance: suggestion.significance,
          page_ids_json: JSON.stringify(suggestion.pageIds),
          page_hashes_json: JSON.stringify(suggestion.pageHashes),
          source_ids_json: JSON.stringify(suggestion.sourceIds),
          production_method: "llm_cross_source_review",
          model,
          confidence: suggestion.confidence,
        });
        const discoveryId = insertedId ??
          db.discoveries.getDiscoveries().find((item) =>
            item.fingerprint === fingerprint
          )
            ?.id;
        if (discoveryId === undefined) {
          throw new Error("Discovery proposal could not be recorded");
        }
        if (
          !db.discoveries.reviewDiscoveryCandidate(
            generation,
            candidate.record.fingerprint,
            "proposed",
            discoveryId,
          )
        ) {
          throw new Error("Discovery candidate review state changed");
        }
        if (insertedId !== undefined) insertedIds.push(insertedId);
      }
    });
  }
  return {
    discoveries: insertedIds.map((id) => getDiscoveryView(db, id)),
    coverage: discoveryCoverage(db, generation, pages.size),
  };
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

function renderWithExistingSources(
  markdown: string,
  links: string[],
  relationship: WikiRelationship,
): string {
  const page = parseWikiPage(markdown);
  const rendered = renderWikiPage(
    validateWikiPage({
      ...page,
      links,
      relationships: [...(page.relationships ?? []), relationship],
    }),
    [],
  );
  const sourceLines = markdown.split("\n").filter((line) =>
    /<!-- synthesis-source:[a-f0-9]{64} -->/.test(line)
  );
  const result = sourceLines.length === 0
    ? rendered
    : `${rendered.trimEnd()}\n\n## Sources\n\n${sourceLines.join("\n")}\n`;
  parseWikiPage(result);
  return result;
}

function selectDiscoveryPair(
  db: DB,
  view: DiscoveryView,
  explicitPairs: Set<string>,
): [number, number] | undefined {
  for (const requireDifferentSources of [true, false]) {
    for (let leftIndex = 0; leftIndex < view.pages.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < view.pages.length;
        rightIndex++
      ) {
        const left = view.pages[leftIndex].id;
        const right = view.pages[rightIndex].id;
        if (explicitPairs.has(pairKey(left, right))) continue;
        if (requireDifferentSources) {
          const leftSources = db.sources.getSourceProvenanceForNote(left).map((
            source,
          ) => source.id);
          const rightSources = db.sources.getSourceProvenanceForNote(right).map(
            (source) => source.id,
          );
          if (sourceSetsOverlap(leftSources, rightSources)) continue;
        }
        return [left, right];
      }
    }
  }
  return undefined;
}

async function assertDiscoveryEvidenceCurrent(
  db: DB,
  record: DiscoveryRecord,
): Promise<void> {
  const pageIds = storedIds(
    record.page_ids_json,
    `Discovery ${record.id} page IDs`,
    2,
    4,
  );
  const hashes = storedHashes(
    record.page_hashes_json,
    `Discovery ${record.id} page hashes`,
    pageIds.length,
  );
  for (let index = 0; index < pageIds.length; index++) {
    const note = db.notes.getNote(pageIds[index]);
    const current = note ? await candidatePage(db, note) : null;
    if (!current || current.contentHash !== hashes[index]) {
      throw new DiscoveryStateError(
        `Discovery ${record.id} is stale because its wiki evidence changed`,
      );
    }
  }
}

async function reviewableDiscovery(
  db: DB,
  id: number,
  requireFresh = true,
): Promise<DiscoveryView> {
  const record = db.discoveries.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  if (!["pending", "investigating"].includes(record.status)) {
    throw new DiscoveryStateError(
      `Discovery ${id} is already ${record.status}`,
    );
  }
  if (requireFresh) await assertDiscoveryEvidenceCurrent(db, record);
  return discoveryView(db, record);
}

async function restoreDiscoveryFiles(
  originals: Map<string, string>,
  paths: string[],
): Promise<void> {
  let rollbackError: unknown;
  for (const path of [...paths].reverse()) {
    try {
      await replaceFile(path, originals.get(path)!);
    } catch (error) {
      rollbackError ??= error;
      console.error(`Discovery batch rollback failed: ${errMsg(error)}`);
    }
  }
  if (rollbackError) throw new Error("Discovery batch rollback failed");
}

export async function confirmDiscovery(
  db: DB,
  id: number,
): Promise<DiscoveryView> {
  const view = await reviewableDiscovery(db, id);
  const graph = await buildWikiGraph(db);
  const explicitPairs = explicitPairKeys(graph.links);
  const pair = selectDiscoveryPair(db, view, explicitPairs);
  if (!pair) {
    throw new DiscoveryStateError(
      `Discovery ${id} no longer has an unlinked page pair`,
    );
  }

  const source = db.notes.getNote(pair[0]);
  const target = db.notes.getNote(pair[1]);
  if (!source || !target) throw new Error(`Discovery ${id} page is missing`);
  const sourcePath = source.file_path;
  const original = await Deno.readTextFile(sourcePath);
  const page = parseWikiPage(original);
  const links = [...page.links, target.title];
  const content = renderWithExistingSources(original, links, {
    target: target.title,
    type: view.relationshipType as WikiRelationship["type"],
    explanation: view.explanation,
    significance: view.significance,
    pageHashes: view.pageHashes,
    confirmedAt: new Date().toISOString(),
  });
  const record = db.discoveries.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  await assertDiscoveryEvidenceCurrent(db, record);
  if (await Deno.readTextFile(sourcePath) !== original) {
    throw new DiscoveryStateError(
      `Discovery ${id} page changed while confirmation was prepared`,
    );
  }
  await replaceFile(sourcePath, content);

  try {
    if (!db.discoveries.reviewDiscovery(id, "confirmed")) {
      throw new DiscoveryStateError(`Discovery ${id} is no longer reviewable`);
    }
  } catch (error) {
    await replaceFile(sourcePath, original);
    throw error;
  }
  return getDiscoveryView(db, id);
}

export async function reviewDiscoveryBatch(
  db: DB,
  batch: ValidatedDiscoveryBatch,
): Promise<DiscoveryBatchResult> {
  const views = await Promise.all(
    batch.ids.map((id) =>
      reviewableDiscovery(db, id, batch.action === "confirm")
    ),
  );
  if (batch.action === "reject") {
    db.withTransaction(() => {
      for (const id of batch.ids) {
        if (!db.discoveries.reviewDiscovery(id, "rejected")) {
          throw new DiscoveryStateError(
            `Discovery ${id} is no longer reviewable`,
          );
        }
      }
    });
    return {
      action: batch.action,
      reviewed: batch.ids.map((id) => getDiscoveryView(db, id)),
      linksAdded: 0,
    };
  }

  const graph = await buildWikiGraph(db);
  const explicitPairs = explicitPairKeys(graph.links);
  const originals = new Map<string, string>();
  const finalContents = new Map<string, string>();
  for (const view of views) {
    const pair = selectDiscoveryPair(db, view, explicitPairs);
    if (!pair) {
      throw new DiscoveryStateError(
        `Discovery ${view.id} no longer has an unlinked page pair`,
      );
    }
    explicitPairs.add(pairKey(pair[0], pair[1]));
    const source = db.notes.getNote(pair[0]);
    const target = db.notes.getNote(pair[1]);
    if (!source || !target) {
      throw new DiscoveryStateError(
        `Discovery ${view.id} page is no longer available`,
      );
    }
    let original = originals.get(source.file_path);
    if (original === undefined) {
      original = await Deno.readTextFile(source.file_path);
      originals.set(source.file_path, original);
    }
    const current = finalContents.get(source.file_path) ?? original;
    const page = parseWikiPage(current);
    finalContents.set(
      source.file_path,
      renderWithExistingSources(current, [...page.links, target.title], {
        target: target.title,
        type: view.relationshipType as WikiRelationship["type"],
        explanation: view.explanation,
        significance: view.significance,
        pageHashes: view.pageHashes,
        confirmedAt: new Date().toISOString(),
      }),
    );
  }

  for (const view of views) {
    const record = db.discoveries.getDiscovery(view.id);
    if (!record) {
      throw new DiscoveryNotFoundError(`Discovery ${view.id} not found`);
    }
    await assertDiscoveryEvidenceCurrent(db, record);
  }
  for (const [path, original] of originals) {
    if (await Deno.readTextFile(path) !== original) {
      throw new DiscoveryStateError(
        "A wiki page changed while the discovery batch was being prepared",
      );
    }
  }

  const writtenPaths: string[] = [];
  try {
    for (
      const [path, content] of [...finalContents].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ) {
      await replaceFile(path, content);
      writtenPaths.push(path);
    }
  } catch (error) {
    try {
      await restoreDiscoveryFiles(originals, writtenPaths);
    } catch {
      throw new Error("Discovery batch failed and could not be rolled back");
    }
    throw error;
  }

  try {
    db.withTransaction(() => {
      for (const id of batch.ids) {
        if (!db.discoveries.reviewDiscovery(id, "confirmed")) {
          throw new DiscoveryStateError(
            `Discovery ${id} is no longer reviewable`,
          );
        }
      }
    });
  } catch (error) {
    try {
      await restoreDiscoveryFiles(originals, writtenPaths);
    } catch {
      throw new Error("Discovery batch failed and could not be rolled back");
    }
    throw error;
  }

  return {
    action: batch.action,
    reviewed: batch.ids.map((id) => getDiscoveryView(db, id)),
    linksAdded: views.length,
  };
}

export async function reviewDiscovery(
  db: DB,
  id: number,
  status: "investigating" | "rejected",
): Promise<DiscoveryView> {
  const record = db.discoveries.getDiscovery(id);
  if (!record) throw new DiscoveryNotFoundError(`Discovery ${id} not found`);
  if (status === "investigating") {
    await assertDiscoveryEvidenceCurrent(db, record);
  }
  if (!db.discoveries.reviewDiscovery(id, status)) {
    throw new DiscoveryStateError(
      `Discovery ${id} is already ${record.status}`,
    );
  }
  return getDiscoveryView(db, id);
}
