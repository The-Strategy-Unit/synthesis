import type { DatabaseSync } from "node:sqlite";

import type {
  DiscoveryCandidateInput,
  DiscoveryCandidateRecord,
  DiscoveryCandidateStatus,
  DiscoveryGenerationRecord,
  DiscoveryRecord,
  DiscoveryStatus,
} from "./types.ts";

export class DiscoveryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

  addDiscovery(
    discovery: Omit<
      DiscoveryRecord,
      "id" | "status" | "created_at" | "reviewed_at"
    >,
  ): number | undefined {
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO discoveries
       (fingerprint, relationship_type, explanation, significance,
        page_ids_json, page_hashes_json, source_ids_json, production_method,
        model, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      discovery.fingerprint,
      discovery.relationship_type,
      discovery.explanation,
      discovery.significance,
      discovery.page_ids_json,
      discovery.page_hashes_json,
      discovery.source_ids_json,
      discovery.production_method,
      discovery.model,
      discovery.confidence,
    );
    return Number(info.changes) === 1
      ? Number(info.lastInsertRowid)
      : undefined;
  }

  addDiscoveryGeneration(
    generation: Omit<DiscoveryGenerationRecord, "created_at">,
  ): void {
    this.db.prepare(
      `INSERT INTO discovery_generations
       (generation, scope, seed_ids_json, page_snapshot_hash, prompt_version,
        model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      generation.generation,
      generation.scope,
      generation.seed_ids_json,
      generation.page_snapshot_hash,
      generation.prompt_version,
      generation.model,
    );
  }

  getDiscoveryGeneration(
    generation: string,
  ): DiscoveryGenerationRecord | undefined {
    return this.db.prepare(
      "SELECT * FROM discovery_generations WHERE generation = ?",
    ).get(generation) as DiscoveryGenerationRecord | undefined;
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
    this.transaction(() => {
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
}
