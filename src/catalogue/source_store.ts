import type { DatabaseSync } from "node:sqlite";

import type { SourceRecord } from "./types.ts";
import type { VaultPathResolver } from "./vault_path.ts";

export class SourceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly paths: VaultPathResolver,
  ) {}

  private resolveSource<T extends SourceRecord>(source: T): T {
    return { ...source, file_path: this.paths.resolve(source.file_path) };
  }

  getSourceByHash(contentHash: string): SourceRecord | undefined {
    const source = this.db.prepare(
      "SELECT * FROM sources WHERE content_hash = ?",
    ).get(contentHash) as SourceRecord | undefined;
    return source ? this.resolveSource(source) : undefined;
  }

  getAllSources(): SourceRecord[] {
    const sources = this.db.prepare(
      "SELECT * FROM sources ORDER BY created_at DESC, id DESC",
    ).all() as unknown as SourceRecord[];
    return sources.map((source) => this.resolveSource(source));
  }

  getSource(id: number): SourceRecord | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    const source = this.db.prepare(
      "SELECT * FROM sources WHERE id = ?",
    ).get(id) as SourceRecord | undefined;
    return source ? this.resolveSource(source) : undefined;
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
    ).run(
      contentHash,
      title,
      sourceUrl,
      sourceType,
      this.paths.store(filePath),
      summary,
    );
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
    const notes = this.db.prepare(
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
    return notes.map((note) => ({
      ...note,
      file_path: this.paths.resolve(note.file_path),
    }));
  }

  getSourcesForNotes(noteIds: number[]): SourceRecord[] {
    const ids = [...new Set(noteIds)].filter((id) =>
      Number.isSafeInteger(id) && id > 0
    );
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const sources = this.db.prepare(
      `SELECT DISTINCT s.*
       FROM sources s
       JOIN note_sources ns ON ns.source_id = s.id
       WHERE ns.note_id IN (${placeholders})
       ORDER BY s.created_at, s.id`,
    ).all(...ids) as unknown as SourceRecord[];
    return sources.map((source) => this.resolveSource(source));
  }

  getSourceProvenanceForNote(
    noteId: number,
  ): Array<SourceRecord & { action: string }> {
    if (!Number.isSafeInteger(noteId) || noteId < 1) return [];
    const sources = this.db.prepare(
      `SELECT s.*, ns.action
       FROM note_sources ns
       JOIN sources s ON s.id = ns.source_id
       WHERE ns.note_id = ?
       ORDER BY s.created_at, s.id`,
    ).all(noteId) as unknown as Array<SourceRecord & { action: string }>;
    return sources.map((source) => this.resolveSource(source));
  }
}
