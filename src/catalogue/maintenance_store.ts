import type { DatabaseSync } from "node:sqlite";

import type { NoteStore } from "./note_store.ts";
import type { SourceStore } from "./source_store.ts";
import type {
  CatalogueNote,
  CatalogueSource,
  IngestUndoChange,
} from "./types.ts";

export class MaintenanceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly notes: NoteStore,
    private readonly sources: SourceStore,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  /** Atomically replace SQLite's derived catalogue from validated vault files. */
  replaceCatalogue(
    sources: CatalogueSource[],
    notes: CatalogueNote[],
  ): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM discovery_candidates;
        DELETE FROM discovery_generations;
        DELETE FROM discoveries;
        DELETE FROM ingest_proposals;
        DELETE FROM note_sources;
        DELETE FROM links;
        DELETE FROM embeddings;
        DELETE FROM catalog_metadata;
        DELETE FROM notes_fts;
        DELETE FROM notes;
        DELETE FROM sources;
      `);

      const sourceIds = new Map<string, number>();
      for (const source of sources) {
        sourceIds.set(
          source.contentHash,
          this.sources.addSource(
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
        const noteId = this.notes.addNote(
          note.title,
          note.filePath,
          primarySource?.sourceUrl ?? null,
          primarySource?.sourceType ?? null,
        );
        this.notes.indexNote(noteId, note.title, note.body);
        for (const sourceHash of note.sourceHashes) {
          const sourceId = sourceIds.get(sourceHash);
          if (sourceId === undefined) {
            throw new Error(
              `Catalogue note "${note.title}" references unknown source ${sourceHash}`,
            );
          }
          this.sources.attachNoteSource(noteId, sourceId, "reference");
        }
      }
    });
  }

  /** Apply catalogue changes for a hash-verified ingest undo. */
  undoIngest(sourceHash: string, changes: IngestUndoChange[]): void {
    this.transaction(() => {
      const source = this.sources.getSourceByHash(sourceHash);
      if (!source) {
        throw new Error(`Undo source ${sourceHash} is not catalogued`);
      }

      for (const change of changes) {
        const note = this.notes.getNoteByFilePath(change.filePath);
        if (!note || note.title !== change.title) {
          throw new Error(`Undo page "${change.title}" is not catalogued`);
        }
        if (change.action === "new") {
          this.notes.deleteNote(note.id);
          continue;
        }
        if (change.restoredBody === undefined) {
          throw new Error(`Undo page "${change.title}" has no restored body`);
        }
        this.notes.indexNote(note.id, note.title, change.restoredBody);
        this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(
          note.id,
        );
        this.db.prepare(
          "DELETE FROM links WHERE source_note_id = ? OR target_note_id = ?",
        ).run(note.id, note.id);
        this.db.prepare(
          "DELETE FROM note_sources WHERE note_id = ? AND source_id = ?",
        ).run(note.id, source.id);
        const remaining = this.sources.getSourceProvenanceForNote(note.id)[0];
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
      this.db.exec("DELETE FROM discovery_generations");
      this.db.exec("DELETE FROM discoveries");
    });
  }
}
