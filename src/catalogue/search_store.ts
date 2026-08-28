import type { DatabaseSync } from "node:sqlite";

import { config } from "../app/config.ts";
import {
  embeddingInput,
  type EmbeddingPurpose,
} from "../provider/embedding.ts";
import type { NoteStore } from "./note_store.ts";
import type { IntegrationCandidate, SemanticIndexStatus } from "./types.ts";

const RECIPROCAL_RANK_OFFSET = 60;

function normalisedSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-GB").replace(
    /\s+/g,
    " ",
  );
}

function titleMatchBoost(query: string, title: string): number {
  const normalisedQuery = normalisedSearchText(query);
  const normalisedTitle = normalisedSearchText(title);
  if (normalisedTitle === normalisedQuery) return 1;
  if (normalisedTitle.startsWith(normalisedQuery)) return 0.25;
  if (normalisedTitle.includes(normalisedQuery)) return 0.1;
  return 0;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
  "with",
]);

export function keywordSearchQueries(value: string): string[] {
  const tokens = [
    ...value.normalize("NFKC").toLocaleLowerCase("en-GB")
      .matchAll(/[\p{L}\p{N}_]+/gu),
  ].map((match) => match[0]);
  const uniqueTokens = [...new Set(tokens)].slice(0, 16);
  if (uniqueTokens.length === 0) return [];

  const meaningfulTokens = uniqueTokens.filter((token) =>
    !SEARCH_STOP_WORDS.has(token)
  );
  const terms = meaningfulTokens.length > 0 ? meaningfulTokens : uniqueTokens;
  const quotedTerms = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
  const precise = quotedTerms.join(" AND ");
  const broad = quotedTerms.join(" OR ");
  return broad === precise ? [precise] : [precise, broad];
}

export class SearchStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly notes: NoteStore,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  semanticIndexStatus(
    expectedIdentity: string | null = null,
  ): SemanticIndexStatus {
    const row = this.db.prepare(
      "SELECT value FROM catalog_metadata WHERE key = 'embedding_identity'",
    ).get() as { value: string } | undefined;
    const identity = row?.value ?? null;
    const embedded = Number(
      (this.db.prepare("SELECT count(*) AS count FROM embeddings").get() as {
        count: number;
      }).count,
    );
    const total = Number(
      (this.db.prepare("SELECT count(*) AS count FROM notes").get() as {
        count: number;
      }).count,
    );
    const compatible = identity !== null &&
      (expectedIdentity === null || identity === expectedIdentity);
    return {
      identity,
      expectedIdentity,
      compatible,
      embedded,
      total,
      remaining: Math.max(0, total - embedded),
      complete: compatible && identity !== null && embedded === total,
    };
  }

  activateSemanticIndex(identity: string): SemanticIndexStatus {
    const normalised = identity.normalize("NFKC").trim();
    if (
      !normalised || normalised.length > 1_000 || /\p{Cc}/u.test(normalised)
    ) {
      throw new Error("Embedding identity is invalid");
    }
    const current = this.semanticIndexStatus();
    if (current.identity !== normalised) {
      this.transaction(() => {
        this.db.exec("DELETE FROM links; DELETE FROM embeddings;");
        this.db.prepare(
          `INSERT INTO catalog_metadata (key, value)
           VALUES ('embedding_identity', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(normalised);
      });
    }
    return this.semanticIndexStatus(normalised);
  }

  clearSemanticIndex(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM links;
        DELETE FROM embeddings;
        DELETE FROM catalog_metadata WHERE key = 'embedding_identity';
      `);
    });
  }

  getNotesWithoutEmbeddings(
    limit: number,
  ): Array<{ id: number; title: string; file_path: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Semantic rebuild limit must be between 1 and 100");
    }
    return this.db.prepare(
      `SELECT n.id, n.title, n.file_path
       FROM notes n
       LEFT JOIN embeddings e ON e.note_id = n.id
       WHERE e.note_id IS NULL
       ORDER BY n.id
       LIMIT ?`,
    ).all(limit) as Array<{ id: number; title: string; file_path: string }>;
  }

  upsertEmbedding(noteId: number, embedding: number[]): void {
    this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(noteId);
    this.db.prepare(
      "INSERT INTO embeddings (note_id, vector) VALUES (?, ?)",
    ).run(BigInt(noteId), new Float32Array(embedding));
  }

  searchKeyword(
    query: string,
    limit = config.search.resultLimit,
  ): Array<{ id: number; title: string; rank: number }> {
    const searches = keywordSearchQueries(query);
    if (searches.length === 0) return [];
    const stmt = this.db.prepare(
      "SELECT rowid as id, title, rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?",
    );
    for (const search of searches) {
      const results = stmt.all(search, limit) as Array<
        { id: number; title: string; rank: number }
      >;
      if (results.length > 0) return results;
    }
    return [];
  }

  findIntegrationCandidates(
    text: string,
    limit = 8,
  ): IntegrationCandidate[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];

    const terms = [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
      .map((match) => match[0])
      .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term));
    const uniqueTerms = [...new Set(terms)].slice(0, 16);
    if (uniqueTerms.length === 0) return [];

    const query = uniqueTerms.map((term) => `"${term}"`).join(" OR ");
    const resultLimit = Math.min(50, Math.trunc(limit));
    return this.db.prepare(
      `SELECT n.id, n.title, notes_fts.content AS body
       FROM notes_fts
       JOIN notes n ON n.id = notes_fts.rowid
       WHERE notes_fts MATCH ?
       ORDER BY notes_fts.rank
       LIMIT ?`,
    ).all(query, resultLimit) as unknown as IntegrationCandidate[];
  }

  searchSemantic(
    queryEmbedding: number[],
    limit = config.search.resultLimit,
  ): Array<{ note_id: number; title: string; similarity: number }> {
    const rows = this.db.prepare(
      `SELECT n.id as note_id, n.title, e.distance
     FROM embeddings e
     JOIN notes n ON n.id = e.note_id
     WHERE e.vector MATCH ? AND e.k = ?
     ORDER BY e.distance`,
    ).all(new Float32Array(queryEmbedding), limit) as Array<
      { note_id: number; title: string; distance: number }
    >;

    return rows.map((r) => ({
      note_id: r.note_id,
      title: r.title,
      similarity: 1 - r.distance,
    }));
  }

  getLinks(): Array<{ source: number; target: number; similarity: number }> {
    return this.db.prepare(
      "SELECT source_note_id as source, target_note_id as target, similarity FROM links",
    ).all() as Array<{ source: number; target: number; similarity: number }>;
  }

  upsertLink(sourceId: number, targetId: number, similarity: number): void {
    const stmt = this.db.prepare(
      "INSERT INTO links (source_note_id, target_note_id, similarity) VALUES (?, ?, ?) " +
        "ON CONFLICT(source_note_id, target_note_id) DO UPDATE SET similarity = excluded.similarity",
    );
    stmt.run(sourceId, targetId, similarity);
  }

  getEmbedding(noteId: number): number[] | null {
    const row = this.db.prepare(
      "SELECT vector FROM embeddings WHERE note_id = ?",
    ).get(noteId) as { vector: Uint8Array } | undefined;
    if (!row) return null;
    return Array.from(new Float32Array(row.vector.buffer));
  }

  getRelatedNotes(
    noteId: number,
    limit?: number,
  ): Array<{ id: number; title: string; similarity: number }> {
    const sql = `SELECT target_note_id as id, n.title, l.similarity
     FROM links l JOIN notes n ON n.id = l.target_note_id
     WHERE l.source_note_id = ?
     UNION
     SELECT source_note_id as id, n.title, l.similarity
     FROM links l JOIN notes n ON n.id = l.source_note_id
     WHERE l.target_note_id = ?
     ORDER BY similarity DESC`;

    if (limit === undefined) {
      return this.db.prepare(sql).all(noteId, noteId) as Array<
        { id: number; title: string; similarity: number }
      >;
    }

    return this.db.prepare(sql + " LIMIT ?").all(
      noteId,
      noteId,
      limit,
    ) as Array<
      { id: number; title: string; similarity: number }
    >;
  }

  clearLinks(): void {
    this.db.exec("DELETE FROM links");
  }

  findNearest(
    excludeId: number,
    embedding: number[],
    k: number,
  ): Array<{ id: number; title: string; similarity: number }> {
    const rows = this.db.prepare(
      `SELECT n.id, n.title, e.distance
     FROM embeddings e
     JOIN notes n ON n.id = e.note_id
     WHERE e.vector MATCH ? AND e.k = ?
     ORDER BY e.distance`,
    ).all(new Float32Array(embedding), k) as Array<
      { id: number; title: string; distance: number }
    >;

    return rows
      .filter((r) => r.id !== excludeId)
      .map((r) => ({ id: r.id, title: r.title, similarity: 1 - r.distance }));
  }

  // Embedding API call (static — no DB state needed)
  static async embedText(
    text: string,
    apiBase: string,
    apiKey: string,
    model: string,
    purpose: EmbeddingPurpose,
    signal?: AbortSignal,
  ): Promise<number[]> {
    let res: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(config.security.modelTimeoutMs);
      res = await fetch(`${apiBase}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: embeddingInput(text, model, purpose),
          dimensions: config.embed.dimensions,
        }),
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const errorName = err instanceof Error ? err.name : "UnknownError";
      if (errorName === "TimeoutError" || errorName === "AbortError") {
        throw new Error("Embedding request timed out");
      }
      console.error(`Embedding API transport failed (${errorName})`);
      throw new Error("Unable to contact the embedding service");
    }

    if (!res.ok) {
      console.error(`Embedding API request failed with status ${res.status}`);
      await res.body?.cancel();
      throw new Error(`Embedding service rejected the request (${res.status})`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error("Embedding service returned an invalid response");
    }

    const embedding = (payload as {
      data?: Array<{ embedding?: unknown }>;
    })?.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== config.embed.dimensions ||
      !embedding.every((value) =>
        typeof value === "number" && Number.isFinite(value)
      )
    ) {
      throw new Error("Embedding service returned an invalid embedding");
    }
    return embedding;
  }

  // Embed + store in one call
  async embedAndStore(
    noteId: number,
    title: string,
    body: string,
    apiBase: string,
    apiKey: string,
    model: string,
  ): Promise<number[]> {
    const embedding = await SearchStore.embedText(
      `${title}\n${body}`,
      apiBase,
      apiKey,
      model,
      "document",
    );
    this.upsertEmbedding(noteId, embedding);
    return embedding;
  }

  // Shared mutual-kNN logic used by complete semantic graph rebuilds. A page
  // pair is retained only when each page ranks the other among its nearest
  // positive-similarity cross-source neighbours. This avoids presenting an
  // arbitrary final neighbour as a semantic relationship merely because k
  // slots were requested.
  private linkNotes(
    noteIds: number[],
    k: number,
    seen: Set<string>,
  ): number {
    const sourceIdsByNote = new Map<number, Set<number>>();
    for (const note of this.notes.getAllNotes()) {
      sourceIdsByNote.set(note.id, new Set());
    }
    const provenanceRows = this.db.prepare(
      "SELECT note_id, source_id FROM note_sources ORDER BY note_id, source_id",
    ).all() as Array<{ note_id: number; source_id: number }>;
    for (const row of provenanceRows) {
      sourceIdsByNote.get(row.note_id)?.add(row.source_id);
    }
    const candidatePool = Number(
      (this.db.prepare("SELECT count(*) AS count FROM embeddings").get() as {
        count: number;
      }).count,
    );
    const rankings = new Map<
      number,
      Array<{ id: number; similarity: number }>
    >();
    for (const noteId of noteIds) {
      const emb = this.getEmbedding(noteId);
      if (!emb) continue;
      const ownSources = sourceIdsByNote.get(noteId) ?? new Set<number>();
      const selected: Array<{ id: number; similarity: number }> = [];
      for (const n of this.findNearest(noteId, emb, candidatePool)) {
        const neighbourSources = sourceIdsByNote.get(n.id) ?? new Set<number>();
        if (
          ownSources.size > 0 &&
          [...ownSources].some((sourceId) => neighbourSources.has(sourceId))
        ) {
          continue;
        }
        if (!Number.isFinite(n.similarity) || n.similarity <= 0) continue;
        selected.push({ id: n.id, similarity: n.similarity });
        if (selected.length >= k) break;
      }
      rankings.set(noteId, selected);
    }

    let count = 0;
    for (const [noteId, candidates] of rankings) {
      for (const candidate of candidates) {
        const reciprocal = rankings.get(candidate.id)?.find((neighbour) =>
          neighbour.id === noteId
        );
        if (!reciprocal) continue;
        const key = `${Math.min(noteId, candidate.id)}-${
          Math.max(noteId, candidate.id)
        }`;
        if (!seen.has(key)) {
          seen.add(key);
          this.upsertLink(
            Math.min(noteId, candidate.id),
            Math.max(noteId, candidate.id),
            Math.min(candidate.similarity, reciprocal.similarity),
          );
          count++;
        }
      }
    }
    return count;
  }

  // Semantic links for graph use positive mutual nearest-neighbour evidence.
  // Absolute model-specific score thresholds are deliberately avoided.
  computeLinks(k = config.link.k): number {
    if (!Number.isSafeInteger(k) || k < 1) {
      throw new RangeError(
        "Semantic neighbour count must be a positive integer",
      );
    }
    return this.transaction(() => {
      this.clearLinks();
      const notes = this.notes.getAllNotes();
      return this.linkNotes(
        notes.map((n) => n.id),
        k,
        new Set<string>(),
      );
    });
  }

  // Changing one embedding can change another page's nearest-neighbour set.
  // Recompute the complete derived graph to keep the rank-bounded topology
  // coherent instead of leaving asymmetric stale edges behind.
  computeLinksFor(
    noteIds: number[],
    k = config.link.k,
  ): number {
    const uniqueIds = [...new Set(noteIds)];
    if (uniqueIds.length === 0) return 0;
    return this.computeLinks(k);
  }

  // Combined keyword + semantic search
  async search(
    query: string,
    apiBase: string,
    apiKey: string,
    embedModel: string,
    limit = config.search.resultLimit,
  ): Promise<
    Array<{ id: number; title: string; score: number; matchType: string }>
  > {
    const [kw, qEmb] = await Promise.all([
      Promise.resolve(this.searchKeyword(query, limit)),
      SearchStore.embedText(query, apiBase, apiKey, embedModel, "query").catch(
        () => null,
      ),
    ]);
    const fused = new Map<number, {
      id: number;
      title: string;
      score: number;
      keyword: boolean;
      semantic: boolean;
    }>();
    const addRank = (
      id: number,
      title: string,
      rank: number,
      kind: "keyword" | "semantic",
    ) => {
      const result = fused.get(id) ?? {
        id,
        title,
        score: titleMatchBoost(query, title),
        keyword: false,
        semantic: false,
      };
      result.score += 1 / (RECIPROCAL_RANK_OFFSET + rank + 1);
      result[kind] = true;
      fused.set(id, result);
    };
    kw.forEach((result, rank) =>
      addRank(result.id, result.title, rank, "keyword")
    );
    if (qEmb) {
      this.searchSemantic(qEmb, limit).forEach((result, rank) =>
        addRank(result.note_id, result.title, rank, "semantic")
      );
    }
    return [...fused.values()]
      .map((result) => ({
        id: result.id,
        title: result.title,
        score: result.score,
        matchType: result.keyword && result.semantic
          ? "both"
          : result.keyword
          ? "keyword"
          : "semantic",
      }))
      .sort((left, right) =>
        right.score - left.score ||
        left.title.localeCompare(right.title, "en-GB")
      )
      .slice(0, limit);
  }
}
