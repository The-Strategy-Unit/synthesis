import type { DatabaseSync } from "node:sqlite";

import type { IngestProposalRecord } from "./types.ts";

export class ProposalStore {
  constructor(private readonly db: DatabaseSync) {}

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

  replacePendingIngestProposal(id: number, proposalJson: string): boolean {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    const info = this.db.prepare(
      `UPDATE ingest_proposals
       SET proposal_json = ?, created_at = datetime('now'), reviewed_at = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(proposalJson, id);
    return Number(info.changes) === 1;
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
}
