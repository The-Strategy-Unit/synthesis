import { DatabaseSync } from "node:sqlite";

import { load } from "sqlite-vec";
import { config } from "./config.ts";

const EMBEDDING_DIM = config.embed.dimensions;
const RECIPROCAL_RANK_OFFSET = 60;

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(
    /\s+/g,
    " ",
  );
}

function titleMatchBoost(query: string, title: string): number {
  const normalizedQuery = normalizedSearchText(query);
  const normalizedTitle = normalizedSearchText(title);
  if (normalizedTitle === normalizedQuery) return 1;
  if (normalizedTitle.startsWith(normalizedQuery)) return 0.25;
  if (normalizedTitle.includes(normalizedQuery)) return 0.1;
  return 0;
}

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

CREATE TABLE IF NOT EXISTS ingest_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  proposal_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'investigating', 'confirmed', 'rejected')),
  relationship_type TEXT NOT NULL,
  explanation TEXT NOT NULL,
  significance TEXT NOT NULL,
  page_ids_json TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  production_method TEXT NOT NULL,
  model TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS discovery_candidates (
  fingerprint TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  left_note_id INTEGER NOT NULL,
  right_note_id INTEGER NOT NULL,
  left_hash TEXT NOT NULL,
  right_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  lexical_similarity REAL NOT NULL
    CHECK (lexical_similarity >= 0 AND lexical_similarity <= 1),
  semantic_similarity REAL
    CHECK (semantic_similarity IS NULL OR
      (semantic_similarity >= -1 AND semantic_similarity <= 1)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'reviewed', 'proposed')),
  discovery_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT,
  CHECK (left_note_id < right_note_id),
  FOREIGN KEY (left_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (right_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (discovery_id) REFERENCES discoveries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS discovery_candidates_generation_status
  ON discovery_candidates(generation, status, score DESC, fingerprint);
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

export interface IngestProposalRecord {
  id: number;
  source_id: number;
  status: "pending" | "approved" | "rejected";
  proposal_json: string;
  created_at: string;
  reviewed_at: string | null;
}

export type DiscoveryStatus =
  | "pending"
  | "investigating"
  | "confirmed"
  | "rejected";

export interface DiscoveryRecord {
  id: number;
  fingerprint: string;
  status: DiscoveryStatus;
  relationship_type: string;
  explanation: string;
  significance: string;
  page_ids_json: string;
  source_ids_json: string;
  production_method: string;
  model: string;
  confidence: number;
  created_at: string;
  reviewed_at: string | null;
}

export type DiscoveryCandidateStatus = "queued" | "reviewed" | "proposed";

export interface DiscoveryCandidateRecord {
  fingerprint: string;
  generation: string;
  left_note_id: number;
  right_note_id: number;
  left_hash: string;
  right_hash: string;
  prompt_version: string;
  model: string;
  score: number;
  lexical_similarity: number;
  semantic_similarity: number | null;
  status: DiscoveryCandidateStatus;
  discovery_id: number | null;
  created_at: string;
  reviewed_at: string | null;
}

export type DiscoveryCandidateInput = Omit<
  DiscoveryCandidateRecord,
  "status" | "discovery_id" | "created_at" | "reviewed_at"
>;

export interface IntegrationCandidate {
  id: number;
  title: string;
  body: string;
}

export interface CatalogSource {
  contentHash: string;
  title: string;
  sourceUrl: string | null;
  sourceType: string;
  filePath: string;
  summary: string;
}

export interface CatalogNote {
  title: string;
  filePath: string;
  body: string;
  sourceHashes: string[];
}

export interface IngestUndoChange {
  action: "new" | "merge" | "contradict";
  title: string;
  filePath: string;
  restoredBody?: string;
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
    ...value.normalize("NFKC").toLocaleLowerCase("en-US")
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

  getAllSources(): SourceRecord[] {
    return this.db.prepare(
      "SELECT * FROM sources ORDER BY created_at DESC, id DESC",
    ).all() as unknown as SourceRecord[];
  }

  getSource(id: number): SourceRecord | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    return this.db.prepare(
      "SELECT * FROM sources WHERE id = ?",
    ).get(id) as SourceRecord | undefined;
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

  addIngestProposal(sourceId: number, proposalJson: string): number {
    const info = this.db.prepare(
      `INSERT INTO ingest_proposals (source_id, proposal_json)
       VALUES (?, ?)`,
    ).run(sourceId, proposalJson);
    return Number(info.lastInsertRowid);
  }

  getIngestProposal(id: number): IngestProposalRecord | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    return this.db.prepare(
      "SELECT * FROM ingest_proposals WHERE id = ?",
    ).get(id) as IngestProposalRecord | undefined;
  }

  getIngestProposalForSource(
    sourceId: number,
  ): IngestProposalRecord | undefined {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) return undefined;
    return this.db.prepare(
      "SELECT * FROM ingest_proposals WHERE source_id = ?",
    ).get(sourceId) as IngestProposalRecord | undefined;
  }

  getIngestProposals(
    status?: IngestProposalRecord["status"],
  ): IngestProposalRecord[] {
    if (status === undefined) {
      return this.db.prepare(
        "SELECT * FROM ingest_proposals ORDER BY created_at DESC, id DESC",
      ).all() as unknown as IngestProposalRecord[];
    }
    return this.db.prepare(
      `SELECT * FROM ingest_proposals
       WHERE status = ?
       ORDER BY created_at DESC, id DESC`,
    ).all(status) as unknown as IngestProposalRecord[];
  }

  reviewIngestProposal(
    id: number,
    status: "approved" | "rejected",
  ): boolean {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    const info = this.db.prepare(
      `UPDATE ingest_proposals
       SET status = ?, reviewed_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    ).run(status, id);
    return Number(info.changes) === 1;
  }

  addDiscovery(
    discovery: Omit<
      DiscoveryRecord,
      "id" | "status" | "created_at" | "reviewed_at"
    >,
  ): number | undefined {
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO discoveries
       (fingerprint, relationship_type, explanation, significance,
        page_ids_json, source_ids_json, production_method, model, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      discovery.fingerprint,
      discovery.relationship_type,
      discovery.explanation,
      discovery.significance,
      discovery.page_ids_json,
      discovery.source_ids_json,
      discovery.production_method,
      discovery.model,
      discovery.confidence,
    );
    return Number(info.changes) === 1
      ? Number(info.lastInsertRowid)
      : undefined;
  }

  getDiscovery(id: number): DiscoveryRecord | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    return this.db.prepare(
      "SELECT * FROM discoveries WHERE id = ?",
    ).get(id) as DiscoveryRecord | undefined;
  }

  getDiscoveries(status?: DiscoveryStatus): DiscoveryRecord[] {
    if (status === undefined) {
      return this.db.prepare(
        "SELECT * FROM discoveries ORDER BY created_at DESC, id DESC",
      ).all() as unknown as DiscoveryRecord[];
    }
    return this.db.prepare(
      `SELECT * FROM discoveries
       WHERE status = ?
       ORDER BY created_at DESC, id DESC`,
    ).all(status) as unknown as DiscoveryRecord[];
  }

  reviewDiscovery(
    id: number,
    status: Exclude<DiscoveryStatus, "pending">,
  ): boolean {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    const allowedCurrent = status === "investigating"
      ? "status = 'pending'"
      : "status IN ('pending', 'investigating')";
    const info = this.db.prepare(
      `UPDATE discoveries
       SET status = ?, reviewed_at = datetime('now')
       WHERE id = ? AND ${allowedCurrent}`,
    ).run(status, id);
    return Number(info.changes) === 1;
  }

  stageDiscoveryCandidates(
    generation: string,
    candidates: DiscoveryCandidateInput[],
  ): void {
    if (!generation || generation.length > 100) {
      throw new Error("Discovery candidate generation is invalid");
    }
    this.withTransaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO discovery_candidates
         (fingerprint, generation, left_note_id, right_note_id,
          left_hash, right_hash, prompt_version, model, score,
          lexical_similarity, semantic_similarity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           generation = excluded.generation,
           score = excluded.score,
           lexical_similarity = excluded.lexical_similarity,
           semantic_similarity = excluded.semantic_similarity`,
      );
      for (const candidate of candidates) {
        statement.run(
          candidate.fingerprint,
          generation,
          candidate.left_note_id,
          candidate.right_note_id,
          candidate.left_hash,
          candidate.right_hash,
          candidate.prompt_version,
          candidate.model,
          candidate.score,
          candidate.lexical_similarity,
          candidate.semantic_similarity,
        );
      }
    });
  }

  getDiscoveryCandidates(
    generation: string,
    status?: DiscoveryCandidateStatus,
    limit?: number,
  ): DiscoveryCandidateRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error("Discovery candidate limit must be a positive integer");
    }
    const where = status === undefined
      ? "generation = ?"
      : "generation = ? AND status = ?";
    const sql = `SELECT * FROM discovery_candidates
      WHERE ${where}
      ORDER BY score DESC, fingerprint${limit === undefined ? "" : " LIMIT ?"}`;
    const parameters: Array<string | number> = [generation];
    if (status !== undefined) parameters.push(status);
    if (limit !== undefined) parameters.push(limit);
    return this.db.prepare(sql).all(
      ...parameters,
    ) as unknown as DiscoveryCandidateRecord[];
  }

  getDiscoveryCandidateCoverage(generation: string): {
    total: number;
    queued: number;
    reviewed: number;
    proposed: number;
  } {
    const row = this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed,
         SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed
       FROM discovery_candidates
       WHERE generation = ?`,
    ).get(generation) as {
      total: number;
      queued: number | null;
      reviewed: number | null;
      proposed: number | null;
    };
    return {
      total: Number(row.total),
      queued: Number(row.queued ?? 0),
      reviewed: Number(row.reviewed ?? 0),
      proposed: Number(row.proposed ?? 0),
    };
  }

  reviewDiscoveryCandidate(
    generation: string,
    fingerprint: string,
    status: Exclude<DiscoveryCandidateStatus, "queued">,
    discoveryId: number | null,
  ): boolean {
    if ((status === "proposed") !== (discoveryId !== null)) {
      throw new Error("Proposed candidates require a discovery ID");
    }
    const info = this.db.prepare(
      `UPDATE discovery_candidates
       SET status = ?, discovery_id = ?, reviewed_at = datetime('now')
       WHERE generation = ? AND fingerprint = ? AND status = 'queued'`,
    ).run(status, discoveryId, generation, fingerprint);
    return Number(info.changes) === 1;
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

  getSourcesForNotes(noteIds: number[]): SourceRecord[] {
    const ids = [...new Set(noteIds)].filter((id) =>
      Number.isSafeInteger(id) && id > 0
    );
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.prepare(
      `SELECT DISTINCT s.*
       FROM sources s
       JOIN note_sources ns ON ns.source_id = s.id
       WHERE ns.note_id IN (${placeholders})
       ORDER BY s.created_at, s.id`,
    ).all(...ids) as unknown as SourceRecord[];
  }

  getSourceProvenanceForNote(
    noteId: number,
  ): Array<SourceRecord & { action: string }> {
    if (!Number.isSafeInteger(noteId) || noteId < 1) return [];
    return this.db.prepare(
      `SELECT s.*, ns.action
       FROM note_sources ns
       JOIN sources s ON s.id = ns.source_id
       WHERE ns.note_id = ?
       ORDER BY s.created_at, s.id`,
    ).all(noteId) as unknown as Array<SourceRecord & { action: string }>;
  }

  getNoteByExactTitle(title: string): {
    id: number;
    title: string;
    file_path: string;
    source_url: string | null;
    source_type: string | null;
    created_at: string;
  } | undefined {
    return this.db.prepare(
      `SELECT * FROM notes
       WHERE title = ? COLLATE NOCASE
       ORDER BY id
       LIMIT 1`,
    ).get(title) as {
      id: number;
      title: string;
      file_path: string;
      source_url: string | null;
      source_type: string | null;
      created_at: string;
    } | undefined;
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

  /** Atomically replace SQLite's derived catalog from validated vault files. */
  replaceCatalog(sources: CatalogSource[], notes: CatalogNote[]): void {
    this.withTransaction(() => {
      this.db.exec(`
        DELETE FROM discovery_candidates;
        DELETE FROM discoveries;
        DELETE FROM ingest_proposals;
        DELETE FROM note_sources;
        DELETE FROM links;
        DELETE FROM embeddings;
        DELETE FROM notes_fts;
        DELETE FROM notes;
        DELETE FROM sources;
      `);

      const sourceIds = new Map<string, number>();
      for (const source of sources) {
        sourceIds.set(
          source.contentHash,
          this.addSource(
            source.contentHash,
            source.title,
            source.sourceUrl,
            source.sourceType,
            source.filePath,
            source.summary,
          ),
        );
      }

      for (const note of notes) {
        const primarySource = note.sourceHashes.length > 0
          ? sources.find((source) =>
            source.contentHash === note.sourceHashes[0]
          )
          : undefined;
        const noteId = this.addNote(
          note.title,
          note.filePath,
          primarySource?.sourceUrl ?? null,
          primarySource?.sourceType ?? null,
        );
        this.indexNote(noteId, note.title, note.body);
        for (const sourceHash of note.sourceHashes) {
          const sourceId = sourceIds.get(sourceHash);
          if (sourceId === undefined) {
            throw new Error(
              `Catalog note "${note.title}" references unknown source ${sourceHash}`,
            );
          }
          this.attachNoteSource(noteId, sourceId, "reference");
        }
      }
    });
  }

  /** Apply catalog changes for a hash-verified ingest undo. */
  undoIngest(sourceHash: string, changes: IngestUndoChange[]): void {
    this.withTransaction(() => {
      const source = this.getSourceByHash(sourceHash);
      if (!source) {
        throw new Error(`Undo source ${sourceHash} is not cataloged`);
      }

      for (const change of changes) {
        const note = this.getNoteByFilePath(change.filePath);
        if (!note || note.title !== change.title) {
          throw new Error(`Undo page "${change.title}" is not cataloged`);
        }
        if (change.action === "new") {
          this.deleteNote(note.id);
          continue;
        }
        if (change.restoredBody === undefined) {
          throw new Error(`Undo page "${change.title}" has no restored body`);
        }
        this.indexNote(note.id, note.title, change.restoredBody);
        this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(
          note.id,
        );
        this.db.prepare(
          "DELETE FROM links WHERE source_note_id = ? OR target_note_id = ?",
        ).run(note.id, note.id);
        this.db.prepare(
          "DELETE FROM note_sources WHERE note_id = ? AND source_id = ?",
        ).run(note.id, source.id);
        const remaining = this.getSourceProvenanceForNote(note.id)[0];
        this.db.prepare(
          "UPDATE notes SET source_url = ?, source_type = ? WHERE id = ?",
        ).run(
          remaining?.source_url ?? null,
          remaining?.source_type ?? null,
          note.id,
        );
      }

      this.db.prepare("DELETE FROM ingest_proposals WHERE source_id = ?").run(
        source.id,
      );
      this.db.exec("DELETE FROM discovery_candidates");
      this.db.exec("DELETE FROM discoveries");
    });
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
  // rebuild) and computeLinksFor(). Semantic graph edges deliberately connect
  // pages with disjoint provenance so the graph surfaces cross-source context
  // instead of repeating links already likely to exist within one source.
  private linkNotes(
    noteIds: number[],
    k: number,
    seen: Set<string>,
  ): number {
    const sourceIdsByNote = new Map<number, Set<number>>();
    for (const note of this.getAllNotes()) {
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
    let count = 0;
    for (const noteId of noteIds) {
      const emb = this.getEmbedding(noteId);
      if (!emb) continue;
      const ownSources = sourceIdsByNote.get(noteId) ?? new Set<number>();
      let selected = 0;
      for (const n of this.findNearest(noteId, emb, candidatePool)) {
        const neighborSources = sourceIdsByNote.get(n.id) ?? new Set<number>();
        if (
          ownSources.size > 0 &&
          [...ownSources].some((sourceId) => neighborSources.has(sourceId))
        ) {
          continue;
        }
        selected++;
        const key = `${Math.min(noteId, n.id)}-${Math.max(noteId, n.id)}`;
        if (!seen.has(key)) {
          seen.add(key);
          this.upsertLink(
            Math.min(noteId, n.id),
            Math.max(noteId, n.id),
            n.similarity,
          );
          count++;
        }
        if (selected >= k) break;
      }
    }
    return count;
  }

  // Semantic links for graph — retain each page's nearest cross-source
  // neighbours. Absolute cosine thresholds are model- and corpus-dependent;
  // breadth is bounded by rank instead.
  computeLinks(k = config.link.k): number {
    if (!Number.isSafeInteger(k) || k < 1) {
      throw new RangeError(
        "Semantic neighbour count must be a positive integer",
      );
    }
    return this.withTransaction(() => {
      this.clearLinks();
      const notes = this.getAllNotes();
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
      DB.embedText(query, apiBase, apiKey, embedModel).catch(() => null),
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
        left.title.localeCompare(right.title, "en-US")
      )
      .slice(0, limit);
  }
}
