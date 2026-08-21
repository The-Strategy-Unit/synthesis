import { parseWikiPage, type WikiPage } from "./wiki.ts";

export type IngestProposalAction = "new" | "merge" | "contradict";

export interface NewIngestProposalChange {
  action: "new";
  markdown: string;
}

export interface ExistingIngestProposalChange {
  action: "merge" | "contradict";
  pageId: number;
  baseContentHash: string;
  markdown: string;
}

export type IngestProposalChange =
  | NewIngestProposalChange
  | ExistingIngestProposalChange;

export interface IngestProposal {
  version: 1;
  sourceId: number;
  contentHash: string;
  changes: IngestProposalChange[];
}

export interface ReviewedIngestProposalChange {
  action: IngestProposalAction;
  pageId?: number;
  baseContentHash?: string;
  markdown: string;
  page: WikiPage;
}

export interface ReviewedIngestProposal extends IngestProposal {
  reviewedChanges: ReviewedIngestProposalChange[];
}

export interface IngestProposalApprovalChange {
  index: number;
  body?: string;
}

export interface IngestProposalApproval {
  changes?: IngestProposalApprovalChange[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHANGES = 12;
const MAX_MARKDOWN_LENGTH = 30_000;
const MAX_BODY_LENGTH = 20_000;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${context} must be a positive integer`);
  }
  return Number(value);
}

function contentHash(value: unknown, context: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function pageMarkdown(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.length > MAX_MARKDOWN_LENGTH) {
    throw new Error(
      `${context} must not exceed ${MAX_MARKDOWN_LENGTH} characters`,
    );
  }
  parseWikiPage(normalized);
  return normalized;
}

export function validateIngestProposal(
  value: unknown,
): ReviewedIngestProposal {
  const proposal = asRecord(value, "Ingest proposal");
  if (proposal.version !== 1) {
    throw new Error("Ingest proposal.version must be 1");
  }
  const sourceId = positiveId(proposal.sourceId, "Ingest proposal.sourceId");
  const hash = contentHash(
    proposal.contentHash,
    "Ingest proposal.contentHash",
  );
  if (!Array.isArray(proposal.changes)) {
    throw new Error("Ingest proposal.changes must be an array");
  }
  if (proposal.changes.length < 1 || proposal.changes.length > MAX_CHANGES) {
    throw new Error(
      `Ingest proposal.changes must contain 1-${MAX_CHANGES} changes`,
    );
  }

  const reviewedChanges = proposal.changes.map((value, index) => {
    const context = `Ingest proposal.changes[${index}]`;
    const change = asRecord(value, context);
    if (!["new", "merge", "contradict"].includes(String(change.action))) {
      throw new Error(`${context}.action must be new, merge, or contradict`);
    }
    const action = change.action as IngestProposalAction;
    const markdown = pageMarkdown(change.markdown, `${context}.markdown`);
    const page = parseWikiPage(markdown);
    if (action === "new") {
      return { action, markdown, page };
    }
    return {
      action,
      pageId: positiveId(change.pageId, `${context}.pageId`),
      baseContentHash: contentHash(
        change.baseContentHash,
        `${context}.baseContentHash`,
      ),
      markdown,
      page,
    };
  });

  const pageIds = new Set<number>();
  const pageTitles = new Set<string>();
  for (const change of reviewedChanges) {
    if (change.pageId !== undefined) {
      if (pageIds.has(change.pageId)) {
        throw new Error(
          `Ingest proposal contains duplicate target page ID ${change.pageId}`,
        );
      }
      pageIds.add(change.pageId);
    }
    const title = change.page.title.toLocaleLowerCase("en-US");
    if (pageTitles.has(title)) {
      throw new Error(
        `Ingest proposal contains duplicate page title "${change.page.title}"`,
      );
    }
    pageTitles.add(title);
  }

  return {
    version: 1,
    sourceId,
    contentHash: hash,
    changes: reviewedChanges.map(({ page: _page, ...change }) => change),
    reviewedChanges,
  };
}

export function serializeIngestProposal(value: unknown): string {
  const { reviewedChanges: _reviewedChanges, ...proposal } =
    validateIngestProposal(value);
  return JSON.stringify(proposal);
}

export function parseStoredIngestProposal(
  value: string,
): ReviewedIngestProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored ingest proposal is invalid JSON");
  }
  try {
    return validateIngestProposal(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored ingest proposal is invalid: ${message}`);
  }
}

export function validateIngestProposalApproval(
  value: unknown,
  options: { requireChanges?: boolean } = {},
): IngestProposalApproval {
  const approval = asRecord(value, "Ingest proposal approval");
  if (approval.changes === undefined) {
    if (options.requireChanges) {
      throw new Error(
        "Ingest proposal approval.changes must explicitly select reviewed changes",
      );
    }
    return {};
  }
  if (
    !Array.isArray(approval.changes) || approval.changes.length < 1 ||
    approval.changes.length > MAX_CHANGES
  ) {
    throw new Error(
      `Ingest proposal approval.changes must contain 1-${MAX_CHANGES} changes`,
    );
  }

  const indexes = new Set<number>();
  const changes = approval.changes.map((value, itemIndex) => {
    const context = `Ingest proposal approval.changes[${itemIndex}]`;
    const change = asRecord(value, context);
    if (!Number.isSafeInteger(change.index) || Number(change.index) < 0) {
      throw new Error(`${context}.index must be a non-negative integer`);
    }
    const index = Number(change.index);
    if (indexes.has(index)) {
      throw new Error(
        `Ingest proposal approval contains duplicate index ${index}`,
      );
    }
    indexes.add(index);

    if (change.body === undefined) return { index };
    if (typeof change.body !== "string") {
      throw new Error(`${context}.body must be a string`);
    }
    const body = change.body.trim().replace(/\r\n?/g, "\n");
    if (!body) throw new Error(`${context}.body must not be empty`);
    if (body.length > MAX_BODY_LENGTH) {
      throw new Error(
        `${context}.body must not exceed ${MAX_BODY_LENGTH} characters`,
      );
    }
    return { index, body };
  });
  return { changes };
}
