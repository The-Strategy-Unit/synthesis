import { relative, resolve } from "node:path";

import { config } from "./config.ts";

export type IngestHistoryAction = "new" | "merge" | "contradict";
export type IngestReviewMode = "manual" | "automatic";

export interface IngestReviewAudit {
  reviewMode: IngestReviewMode;
  batchId?: string;
}

export interface IngestHistoryChange {
  action: IngestHistoryAction;
  pageTitle: string;
  notePath: string;
  beforeRevision?: string;
  beforeHash?: string;
  afterHash: string;
}

export interface IngestHistoryManifest {
  formatVersion: 1;
  historyId: string;
  operation: "ingest";
  proposalId: number;
  sourceHash: string;
  sourceTitle: string;
  appliedAt: string;
  reviewMode: IngestReviewMode;
  batchId?: string;
  changes: IngestHistoryChange[];
}

export interface WrittenIngestHistory {
  directory: string;
  manifest: IngestHistoryManifest;
}

export interface IngestHistoryInputChange {
  action: IngestHistoryAction;
  pageTitle: string;
  filePath: string;
  beforeContent?: string;
  afterContent: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function historyDir(): string {
  return `${config.vaultDir}/history`;
}

async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function notePath(filePath: string): string {
  const path = relative(config.vaultDir, filePath).replaceAll("\\", "/");
  if (!/^notes\/[^/]+\.md$/.test(path)) {
    throw new Error("Ingest history note path must be inside vault notes/");
  }
  return path;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`Ingest history ${name} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > max || /\p{Cc}/u.test(text)) {
    throw new Error(`Ingest history ${name} is invalid`);
  }
  return text;
}

export function validateIngestHistoryManifest(
  value: unknown,
): IngestHistoryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ingest history manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.formatVersion !== 1 || manifest.operation !== "ingest") {
    throw new Error("Ingest history manifest version or operation is invalid");
  }
  if (
    typeof manifest.historyId !== "string" ||
    !UUID_PATTERN.test(manifest.historyId)
  ) {
    throw new Error("Ingest history historyId must be a UUID");
  }
  if (
    typeof manifest.proposalId !== "number" ||
    !Number.isSafeInteger(manifest.proposalId) || manifest.proposalId < 1
  ) {
    throw new Error("Ingest history proposalId must be a positive integer");
  }
  if (
    typeof manifest.sourceHash !== "string" ||
    !SHA256_PATTERN.test(manifest.sourceHash)
  ) {
    throw new Error("Ingest history sourceHash must be a SHA-256 digest");
  }
  const appliedAt = requiredString(manifest.appliedAt, "appliedAt", 40);
  if (
    !ISO_TIMESTAMP_PATTERN.test(appliedAt) ||
    Number.isNaN(Date.parse(appliedAt))
  ) {
    throw new Error("Ingest history appliedAt must be an ISO UTC timestamp");
  }
  const reviewMode = manifest.reviewMode === undefined
    ? "manual"
    : requiredString(manifest.reviewMode, "reviewMode", 20);
  if (reviewMode !== "manual" && reviewMode !== "automatic") {
    throw new Error("Ingest history reviewMode is invalid");
  }
  let batchId: string | undefined;
  if (reviewMode === "automatic") {
    batchId = requiredString(manifest.batchId, "batchId", 36);
    if (!UUID_PATTERN.test(batchId)) {
      throw new Error("Ingest history batchId must be a UUID");
    }
  } else if (manifest.batchId !== undefined) {
    throw new Error("Manual ingest history must not have a batchId");
  }
  if (!Array.isArray(manifest.changes) || manifest.changes.length === 0) {
    throw new Error("Ingest history changes must be a non-empty array");
  }
  const paths = new Set<string>();
  const changes = manifest.changes.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Ingest history changes[${index}] must be an object`);
    }
    const change = value as Record<string, unknown>;
    if (!new Set(["new", "merge", "contradict"]).has(String(change.action))) {
      throw new Error(`Ingest history changes[${index}].action is invalid`);
    }
    const storedPath = requiredString(
      change.notePath,
      `changes[${index}].notePath`,
      500,
    );
    if (!/^notes\/[^/]+\.md$/.test(storedPath) || paths.has(storedPath)) {
      throw new Error(`Ingest history changes[${index}].notePath is invalid`);
    }
    paths.add(storedPath);
    const afterHash = requiredString(
      change.afterHash,
      `changes[${index}].afterHash`,
      64,
    );
    if (!SHA256_PATTERN.test(afterHash)) {
      throw new Error(`Ingest history changes[${index}].afterHash is invalid`);
    }
    const action = change.action as IngestHistoryAction;
    let beforeRevision: string | undefined;
    let beforeHash: string | undefined;
    if (action !== "new") {
      beforeRevision = requiredString(
        change.beforeRevision,
        `changes[${index}].beforeRevision`,
        100,
      );
      if (!/^before\/\d{3}\.md$/.test(beforeRevision)) {
        throw new Error(
          `Ingest history changes[${index}].beforeRevision is invalid`,
        );
      }
      beforeHash = requiredString(
        change.beforeHash,
        `changes[${index}].beforeHash`,
        64,
      );
      if (!SHA256_PATTERN.test(beforeHash)) {
        throw new Error(
          `Ingest history changes[${index}].beforeHash is invalid`,
        );
      }
    }
    return {
      action,
      pageTitle: requiredString(
        change.pageTitle,
        `changes[${index}].pageTitle`,
        120,
      ),
      notePath: storedPath,
      ...(beforeRevision ? { beforeRevision, beforeHash } : {}),
      afterHash,
    };
  });

  return {
    formatVersion: 1,
    historyId: manifest.historyId,
    operation: "ingest",
    proposalId: manifest.proposalId as number,
    sourceHash: manifest.sourceHash,
    sourceTitle: requiredString(manifest.sourceTitle, "sourceTitle", 500),
    appliedAt,
    reviewMode,
    ...(batchId ? { batchId } : {}),
    changes,
  };
}

export async function writeIngestHistory(input: {
  proposalId: number;
  sourceHash: string;
  sourceTitle: string;
  review?: IngestReviewAudit;
  changes: IngestHistoryInputChange[];
}): Promise<WrittenIngestHistory> {
  const historyId = crypto.randomUUID();
  const appliedAt = new Date().toISOString();
  const safeTimestamp = appliedAt.replaceAll(":", "-").replaceAll(".", "-");
  const directoryName = [
    safeTimestamp,
    `proposal-${input.proposalId}`,
    historyId,
  ].join("-");
  const directory = `${historyDir()}/${directoryName}`;
  await Deno.mkdir(historyDir(), { recursive: true });
  await Deno.mkdir(directory);
  try {
    const changes: IngestHistoryChange[] = [];
    for (let index = 0; index < input.changes.length; index++) {
      const change = input.changes[index];
      let beforeRevision: string | undefined;
      let beforeHash: string | undefined;
      if (change.action !== "new") {
        if (change.beforeContent === undefined) {
          throw new Error("Updated history pages require prior content");
        }
        await Deno.mkdir(`${directory}/before`, { recursive: true });
        beforeRevision = `before/${String(index).padStart(3, "0")}.md`;
        await Deno.writeTextFile(
          `${directory}/${beforeRevision}`,
          change.beforeContent,
          { createNew: true },
        );
        beforeHash = await sha256(change.beforeContent);
      }
      changes.push({
        action: change.action,
        pageTitle: change.pageTitle,
        notePath: notePath(change.filePath),
        ...(beforeRevision ? { beforeRevision, beforeHash } : {}),
        afterHash: await sha256(change.afterContent),
      });
    }
    const manifest = validateIngestHistoryManifest({
      formatVersion: 1,
      historyId,
      operation: "ingest",
      proposalId: input.proposalId,
      sourceHash: input.sourceHash,
      sourceTitle: input.sourceTitle,
      appliedAt,
      reviewMode: input.review?.reviewMode ?? "manual",
      ...(input.review?.batchId ? { batchId: input.review.batchId } : {}),
      changes,
    });
    await Deno.writeTextFile(
      `${directory}/manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      { createNew: true },
    );
    return { directory, manifest };
  } catch (error) {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function readIngestHistoryManifest(
  directory: string,
): Promise<IngestHistoryManifest> {
  return validateIngestHistoryManifest(
    JSON.parse(await Deno.readTextFile(`${directory}/manifest.json`)),
  );
}

export async function removeWrittenIngestHistory(
  written: WrittenIngestHistory,
): Promise<void> {
  const root = resolve(historyDir());
  const target = resolve(written.directory);
  if (relative(root, target).startsWith("..") || target === root) {
    throw new Error(
      "Refusing to remove history outside the vault history root",
    );
  }
  await Deno.remove(target, { recursive: true });
}
