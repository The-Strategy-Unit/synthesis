import type { DatabaseSync } from "node:sqlite";

export class NoteStore {
  constructor(private readonly db: DatabaseSync) {}

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

  indexNote(noteId: number, title: string, content: string): void {
    const del = this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?");
    del.run(noteId);
    const ins = this.db.prepare(
      "INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)",
    );
    ins.run(noteId, title, content);
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
}
