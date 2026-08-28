import { DB } from "../catalogue/db.ts";
import {
  type ActiveProviders,
  embeddingIdentity,
} from "../provider/provider_runtime.ts";
import type { WikiQueryPage } from "../wiki/query.ts";
import { buildWikiGraph } from "../wiki/wiki_graph.ts";
import {
  ApiError,
  type ProviderResolver,
  type SemanticSearchGate,
} from "./core.ts";

function semanticIndexView(
  status: ReturnType<DB["search"]["semanticIndexStatus"]> & {
    processed?: number;
    links?: number;
  },
) {
  return {
    compatible: status.compatible,
    embedded: status.embedded,
    total: status.total,
    remaining: status.remaining,
    complete: status.complete,
    ...(status.processed === undefined ? {} : { processed: status.processed }),
    ...(status.links === undefined ? {} : { links: status.links }),
  };
}

async function loadWikiPages(
  db: DB,
  noteIds: number[],
): Promise<WikiQueryPage[]> {
  const pages: WikiQueryPage[] = [];
  for (const id of [...new Set(noteIds)]) {
    const note = db.notes.getNote(id);
    if (!note) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        `Cited wiki page ${id} not found`,
      );
    }
    pages.push({
      id: note.id,
      title: note.title,
      content: (await Deno.readTextFile(note.file_path)).slice(0, 12_000),
    });
  }
  return pages;
}

async function retrieveWikiContext(
  db: DB,
  question: string,
  providers: ActiveProviders,
): Promise<WikiQueryPage[]> {
  const keywordIds = db.search.findIntegrationCandidates(question, 6).map((
    page,
  ) => page.id);
  let semanticIds: number[] = [];
  try {
    requireSemanticIndex(db, providers);
    const embedding = await DB.embedText(
      question,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
      "query",
    );
    semanticIds = db.search.searchSemantic(embedding, 8).map((result) =>
      result.note_id
    );
  } catch {
    // Keyword and explicit-link retrieval remain available without embeddings.
  }

  const seedIds = [...new Set([...keywordIds, ...semanticIds])].slice(0, 8);
  if (seedIds.length === 0) return [];
  const graph = await buildWikiGraph(db);
  const explicitNeighbors = new Map<number, number[]>();
  for (const link of graph.links) {
    if (link.kind !== "explicit") continue;
    explicitNeighbors.set(link.source, [
      ...(explicitNeighbors.get(link.source) ?? []),
      link.target,
    ]);
    explicitNeighbors.set(link.target, [
      ...(explicitNeighbors.get(link.target) ?? []),
      link.source,
    ]);
  }
  const expandedIds = seedIds.flatMap((id) => explicitNeighbors.get(id) ?? []);
  return await loadWikiPages(
    db,
    [...new Set([...seedIds, ...expandedIds])].slice(0, 12),
  );
}

function requireSemanticIndex(
  db: DB,
  providers: ActiveProviders,
): void {
  const status = db.search.semanticIndexStatus(
    embeddingIdentity(providers.embedding),
  );
  if (!status.complete) {
    throw new ApiError(
      409,
      "SEMANTIC_INDEX_INCOMPLETE",
      `Semantic index is incomplete (${status.embedded}/${status.total} pages). Rebuild or resume it, or use keyword search.`,
    );
  }
}

async function wikiLintContext(
  db: DB,
  priorityIds: number[],
): Promise<WikiQueryPage[]> {
  const orderedIds = [
    ...new Set([
      ...priorityIds,
      ...db.notes.getAllNotes().map((note) => note.id),
    ]),
  ].slice(0, 12);
  const pages: WikiQueryPage[] = [];
  for (const id of orderedIds) {
    const note = db.notes.getNote(id);
    if (!note) continue;
    try {
      pages.push({
        id: note.id,
        title: note.title,
        content: (await Deno.readTextFile(note.file_path)).slice(0, 12_000),
      });
    } catch {
      // The deterministic report already records unreadable registered pages.
    }
  }
  return pages;
}

async function semanticSearch(
  db: DB,
  query: string,
  identity: string,
  resolveProviders: ProviderResolver,
  gate: SemanticSearchGate,
) {
  gate.check(identity);
  const provider = await resolveProviders();
  requireSemanticIndex(db, provider);
  return db.search.searchSemantic(
    await DB.embedText(
      query,
      provider.embedding.apiBase,
      provider.embedding.apiKey,
      provider.embedding.model,
      "query",
    ),
  ).map((r) => ({
    id: r.note_id,
    title: r.title,
    score: r.similarity,
    matchType: "semantic",
  }));
}

function keywordSearch(db: DB, query: string) {
  return db.search.searchKeyword(query).map((result) => ({
    id: result.id,
    title: result.title,
    // SQLite FTS ranks better matches with smaller values. Negating the rank
    // gives every search mode the same public ordering rule: higher is better.
    score: -result.rank,
    matchType: "keyword",
  }));
}

async function hybridSearch(
  db: DB,
  query: string,
  identity: string,
  resolveProviders: ProviderResolver,
  gate: SemanticSearchGate,
) {
  try {
    const provider = await resolveProviders();
    requireSemanticIndex(db, provider);
    gate.check(identity);
    return await db.search.search(
      query,
      provider.embedding.apiBase,
      provider.embedding.apiKey,
      provider.embedding.model,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "RATE_LIMITED") {
      throw error;
    }
    return keywordSearch(db, query);
  }
}

function orderSearchResults<
  T extends { title: string; score: number },
>(results: T[]): T[] {
  return [...results].sort((left, right) =>
    right.score - left.score ||
    left.title.localeCompare(right.title, "en-GB")
  );
}

export {
  hybridSearch,
  keywordSearch,
  loadWikiPages,
  orderSearchResults,
  retrieveWikiContext,
  semanticIndexView,
  semanticSearch,
  wikiLintContext,
};
