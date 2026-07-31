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
`;

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

  upsertEmbedding(noteId: number, embedding: number[]): void {
    this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(noteId);
    this.db.prepare(
      "INSERT INTO embeddings (note_id, vector) VALUES (?, ?)",
    ).run(noteId, new Float32Array(embedding));
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
    const res = await fetch(`${apiBase}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()).data[0].embedding as number[];
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

  // Semantic links for graph
  computeLinks(
    threshold = config.link.similarityThreshold,
    k = config.link.k,
  ): number {
    const notes = this.getAllNotes();
    let count = 0;
    const seen = new Set<string>();
    for (const note of notes) {
      const emb = this.getEmbedding(note.id);
      if (!emb) continue;
      for (const n of this.findNearest(note.id, emb, k)) {
        if (n.similarity < threshold) continue;
        const key = `${Math.min(note.id, n.id)}-${Math.max(note.id, n.id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.upsertLink(
          Math.min(note.id, n.id),
          Math.max(note.id, n.id),
          n.similarity,
        );
        count++;
      }
    }
    return count;
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
