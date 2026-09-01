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
  page_hashes_json: string;
  source_ids_json: string;
  production_method: string;
  model: string;
  confidence: number;
  created_at: string;
  reviewed_at: string | null;
}

export interface DiscoveryGenerationRecord {
  generation: string;
  scope: "seeded" | "vault";
  seed_ids_json: string;
  page_snapshot_hash: string;
  prompt_version: string;
  model: string;
  created_at: string;
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

export interface CatalogueSource {
  contentHash: string;
  title: string;
  sourceUrl: string | null;
  sourceType: string;
  filePath: string;
  summary: string;
}

export interface CatalogueNote {
  title: string;
  filePath: string;
  body: string;
  sourceHashes: string[];
  sourceActions?: Record<
    string,
    "new" | "merge" | "contradict" | "reference"
  >;
}

export interface IngestUndoChange {
  action: "new" | "merge" | "contradict";
  title: string;
  filePath: string;
  restoredBody?: string;
}

export interface SemanticIndexStatus {
  identity: string | null;
  expectedIdentity: string | null;
  compatible: boolean;
  embedded: number;
  total: number;
  remaining: number;
  complete: boolean;
}
