import { DatabaseSync } from "node:sqlite";

import { load } from "sqlite-vec";
import { config } from "../app/config.ts";
import { DiscoveryStore } from "./discovery_store.ts";
import { MaintenanceStore } from "./maintenance_store.ts";
import { NoteStore } from "./note_store.ts";
import { ProposalStore } from "./proposal_store.ts";
import { SearchStore } from "./search_store.ts";
import { SourceStore } from "./source_store.ts";

export { keywordSearchQueries } from "./search_store.ts";
export type {
  CatalogueNote,
  CatalogueSource,
  DiscoveryCandidateInput,
  DiscoveryCandidateRecord,
  DiscoveryCandidateStatus,
  DiscoveryGenerationRecord,
  DiscoveryRecord,
  DiscoveryStatus,
  IngestProposalRecord,
  IngestUndoChange,
  IntegrationCandidate,
  SemanticIndexStatus,
  SourceRecord,
} from "./types.ts";

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

CREATE TABLE IF NOT EXISTS catalog_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  page_hashes_json TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  production_method TEXT NOT NULL,
  model TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS discovery_generations (
  generation TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('seeded', 'vault')),
  seed_ids_json TEXT NOT NULL,
  page_snapshot_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
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

export function initDatabase(db: DatabaseSync): void {
  load(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const discoveryColumns = db.prepare("PRAGMA table_info(discoveries)")
    .all() as Array<{ name: string }>;
  if (!discoveryColumns.some((column) => column.name === "page_hashes_json")) {
    db.exec(
      "ALTER TABLE discoveries ADD COLUMN page_hashes_json TEXT NOT NULL DEFAULT '[]'",
    );
  }

  // Vectors created before model identity was recorded cannot be compared
  // safely with future query vectors. Fail closed once during migration.
  const semanticIdentity = db.prepare(
    "SELECT value FROM catalog_metadata WHERE key = 'embedding_identity'",
  ).get() as { value: string } | undefined;
  const embeddingCount = Number(
    (db.prepare("SELECT count(*) AS count FROM embeddings").get() as {
      count: number;
    }).count,
  );
  if (!semanticIdentity && embeddingCount > 0) {
    db.exec("DELETE FROM links; DELETE FROM embeddings;");
  }
}

export class DB {
  static readonly embedText = SearchStore.embedText;

  private readonly connection: DatabaseSync;
  readonly discoveries: DiscoveryStore;
  readonly maintenance: MaintenanceStore;
  readonly notes: NoteStore;
  readonly proposals: ProposalStore;
  readonly search: SearchStore;
  readonly sources: SourceStore;

  constructor(dbPath: string) {
    this.connection = new DatabaseSync(dbPath, { allowExtension: true });
    initDatabase(this.connection);
    const transaction = this.withTransaction.bind(this);
    this.notes = new NoteStore(this.connection);
    this.sources = new SourceStore(this.connection);
    this.proposals = new ProposalStore(this.connection);
    this.discoveries = new DiscoveryStore(this.connection, transaction);
    this.search = new SearchStore(this.connection, this.notes, transaction);
    this.maintenance = new MaintenanceStore(
      this.connection,
      this.notes,
      this.sources,
      transaction,
    );
  }

  withTransaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        // Preserve the error that caused the transaction to fail.
      }
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}
