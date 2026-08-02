import { DatabaseSync } from "node:sqlite";

import { load } from "sqlite-vec";
import { config } from "./config.ts";

const EMBEDDING_DIM = config.embed.dimensions;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  source_url TEXT,
  source_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
  note_id INTEGER PRIMARY KEY,
  vector FLOAT[${EMBEDDING_DIM}] distance_metric=cosine
);

CREATE TABLE IF NOT EXISTS links (
  source_note_id INTEGER NOT NULL,
  target_note_id INTEGER NOT NULL,
  similarity REAL NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  UNIQUE(source_note_id, target_note_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_sources (
  note_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  PRIMARY KEY (note_id, source_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);
`;

export interface SourceRecord {
  id: number;
  content_hash: string;
  title: string;
  source_url: string | null;
  source_type: string;
  file_path: string;
  summary: string;
  created_at: string;
}

export interface IntegrationCandidate {
  id: number;
  title: string;
  body: string;
}

const INTEGRATION_STOP_WORDS = new Set([
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

export function initDatabase(db: DatabaseSync): void {
  load(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
}

export class DB {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    initDatabase(this.db);
  }

  withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  addNote(
    title: string,
    filePath: string,
    sourceUrl: string | null,
    sourceType: string | null,
  ): number {
    const stmt = this.db.prepare(
      "INSERT INTO notes (title, file_path, source_url, source_type) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(title, filePath, sourceUrl, sourceType);
    return Number(info.lastInsertRowid);
  }

  getSourceByHash(contentHash: string): SourceRecord | undefined {
    return this.db.prepare(
      "SELECT * FROM sources WHERE content_hash = ?",
    ).get(contentHash) as SourceRecord | undefined;
  }

  addSource(
    contentHash: string,
    title: string,
    sourceUrl: string | null,
    sourceType: string,
    filePath: string,
    summary: string,
  ): number {
    const info = this.db.prepare(
      `INSERT INTO sources
       (content_hash, title, source_url, source_type, file_path, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(contentHash, title, sourceUrl, sourceType, filePath, summary);
    return Number(info.lastInsertRowid);
  }

  attachNoteSource(noteId: number, sourceId: number, action: string): void {
    this.db.prepare(
      `INSERT INTO note_sources (note_id, source_id, action)
       VALUES (?, ?, ?)
       ON CONFLICT(note_id, source_id) DO UPDATE SET action = excluded.action`,
    ).run(noteId, sourceId, action);
  }

  getNotesForSource(
    sourceId: number,
  ): Array<{
    id: number;
    title: string;
    file_path: string;
    source_url: string | null;
    action: string;
  }> {
    return this.db.prepare(
      `SELECT n.id, n.title, n.file_path, n.source_url, ns.action
       FROM note_sources ns
       JOIN notes n ON n.id = ns.note_id
       WHERE ns.source_id = ?
       ORDER BY n.created_at`,
    ).all(sourceId) as Array<{
      id: number;
      title: string;
      file_path: string;
      source_url: string | null;
      action: string;
    }>;
  }

  upsertEmbedding(noteId: number, embedding: number[]): void {
    this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(noteId);
    this.db.prepare(
      "INSERT INTO embeddings (note_id, vector) VALUES (?, ?)",
    ).run(BigInt(noteId), new Float32Array(embedding));
  }

  indexNote(noteId: number, title: string, content: string): void {
    const del = this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?");
    del.run(noteId);
    const ins = this.db.prepare(
      "INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)",
    );
    ins.run(noteId, title, content);
  }

  searchKeyword(
    query: string,
    limit = config.search.resultLimit,
  ): Array<{ id: number; title: string; rank: number }> {
    const stmt = this.db.prepare(
      "SELECT rowid as id, title, rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?",
    );
    return stmt.all(query, limit) as Array<
      { id: number; title: string; rank: number }
    >;
  }

  findIntegrationCandidates(
    text: string,
    limit = 8,
  ): IntegrationCandidate[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];

    const terms = [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
      .map((match) => match[0])
      .filter((term) => term.length >= 2 && !INTEGRATION_STOP_WORDS.has(term));
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

  getAllNotes(): Array<
    { id: number; title: string; file_path: string; source_url: string | null }
  > {
    return this.db.prepare(
      "SELECT id, title, file_path, source_url FROM notes ORDER BY created_at DESC",
    ).all() as Array<
      {
        id: number;
        title: string;
        file_path: string;
        source_url: string | null;
      }
    >;
  }

  getNote(
    id: number,
  ): {
    id: number;
    title: string;
    file_path: string;
    source_url: string | null;
    source_type: string | null;
  } | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as
      | {
        id: number;
        title: string;
        file_path: string;
        source_url: string | null;
        source_type: string | null;
      }
      | undefined;
  }

  getNoteByFilePath(
    filePath: string,
  ): {
    id: number;
    title: string;
    file_path: string;
    source_url: string | null;
    source_type: string | null;
  } | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE file_path = ?").get(
      filePath,
    ) as
      | {
        id: number;
        title: string;
        file_path: string;
        source_url: string | null;
        source_type: string | null;
      }
      | undefined;
  }

  deleteNote(id: number): void {
    this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(id);
    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(id);
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
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
  ): Promise<number[]> {
    let res: Response;
    try {
      res = await fetch(`${apiBase}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(config.security.modelTimeoutMs),
      });
    } catch (err) {
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
    const embedding = await DB.embedText(
      `${title}\n${body}`,
      apiBase,
      apiKey,
      model,
    );
    this.upsertEmbedding(noteId, embedding);
    return embedding;
  }

  // Shared per-note kNN + upsert logic used by both computeLinks() (full
  // rebuild) and computeLinksFor() (incremental rebuild for touched notes).
  private linkNotes(
    noteIds: number[],
    threshold: number,
    k: number,
    seen: Set<string>,
  ): number {
    let count = 0;
    for (const noteId of noteIds) {
      const emb = this.getEmbedding(noteId);
      if (!emb) continue;
      for (const n of this.findNearest(noteId, emb, k)) {
        if (n.similarity < threshold) continue;
        const key = `${Math.min(noteId, n.id)}-${Math.max(noteId, n.id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.upsertLink(
          Math.min(noteId, n.id),
          Math.max(noteId, n.id),
          n.similarity,
        );
        count++;
      }
    }
    return count;
  }

  // Semantic links for graph — full rebuild over every note in the vault.
  computeLinks(
    threshold = config.link.similarityThreshold,
    k = config.link.k,
  ): number {
    return this.withTransaction(() => {
      this.clearLinks();
      const notes = this.getAllNotes();
      return this.linkNotes(
        notes.map((n) => n.id),
        threshold,
        k,
        new Set<string>(),
      );
    });
  }

  // Incremental link recomputation — only runs the kNN search for the given
  // (newly-created or rewritten) note ids against the rest of the vault,
  // instead of recomputing links for every note.
  computeLinksFor(
    noteIds: number[],
    threshold = config.link.similarityThreshold,
    k = config.link.k,
  ): number {
    const uniqueIds = [...new Set(noteIds)];
    if (uniqueIds.length === 0) return 0;

    return this.withTransaction(() => {
      const deleteLinks = this.db.prepare(
        "DELETE FROM links WHERE source_note_id = ? OR target_note_id = ?",
      );
      for (const noteId of uniqueIds) deleteLinks.run(noteId, noteId);
      return this.linkNotes(uniqueIds, threshold, k, new Set<string>());
    });
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
      DB.embedText(query, apiBase, apiKey, embedModel).catch(() => null),
    ]);
    const scores = new Map<number, { score: number; matchType: string }>();
    for (const r of kw) {
      scores.set(r.id, {
        score: 1 / (1 + Math.abs(r.rank)),
        matchType: "keyword",
      });
    }
    if (qEmb) {
      for (const r of this.searchSemantic(qEmb, limit)) {
        const ex = scores.get(r.note_id);
        scores.set(
          r.note_id,
          ex
            ? { score: (ex.score + r.similarity) / 2, matchType: "both" }
            : { score: r.similarity, matchType: "semantic" },
        );
      }
    }
    return Array.from(scores.entries())
      .map(([id, v]) => ({
        id,
        title: this.getNote(id)?.title ?? "Untitled",
        score: v.score,
        matchType: v.matchType,
      }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
