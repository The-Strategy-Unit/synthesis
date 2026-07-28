import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "./embed.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  source_url TEXT,
  source_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS embeddings (
  note_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_note_model
  ON embeddings(note_id, model);

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

export class DB {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
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

  upsertEmbedding(noteId: number, model: string, embedding: number[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO embeddings (note_id, model, embedding) VALUES (?, ?, ?) " +
        "ON CONFLICT(note_id, model) DO UPDATE SET embedding = excluded.embedding",
    );
    stmt.run(noteId, model, JSON.stringify(embedding));
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
    limit = 20,
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
    limit = 20,
  ): Array<{ note_id: number; title: string; similarity: number }> {
    const rows = this.db.prepare(
      "SELECT e.note_id, n.title, e.embedding FROM embeddings e JOIN notes n ON n.id = e.note_id",
    ).all() as Array<{ note_id: number; title: string; embedding: string }>;

    const results = rows.map((r) => ({
      note_id: r.note_id,
      title: r.title,
      similarity: cosineSimilarity(queryEmbedding, JSON.parse(r.embedding)),
    }));

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
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
      "SELECT embedding FROM embeddings WHERE note_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(noteId) as { embedding: string } | undefined;
    return row ? JSON.parse(row.embedding) : null;
  }

  getRelatedNotes(
    noteId: number,
    limit = 5,
  ): Array<{ id: number; title: string; similarity: number }> {
    return this.db.prepare(
      `SELECT target_note_id as id, n.title, l.similarity
     FROM links l JOIN notes n ON n.id = l.target_note_id
     WHERE l.source_note_id = ?
     UNION
     SELECT source_note_id as id, n.title, l.similarity
     FROM links l JOIN notes n ON n.id = l.source_note_id
     WHERE l.target_note_id = ?
     ORDER BY similarity DESC LIMIT ?`,
    ).all(noteId, noteId, limit) as Array<
      { id: number; title: string; similarity: number }
    >;
  }
}
