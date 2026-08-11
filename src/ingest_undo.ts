import { dirname } from "node:path";

import { config } from "./config.ts";
import type { DB, IngestUndoChange } from "./db.ts";
import {
  historyDir,
  type IngestHistoryManifest,
  readIngestHistoryManifest,
} from "./ingest_history.ts";
import { errMsg } from "./utils.ts";
import { parseWikiPage } from "./wiki.ts";
import { rebuildWikiIndex } from "./wiki_store.ts";

export class IngestUndoNotAvailableError extends Error {}
export class IngestUndoConflictError extends Error {}

export interface IngestUndoResult {
  historyId: string;
  sourceTitle: string;
  restoredCount: number;
  removedCount: number;
  indexUpdated: boolean;
  reset: ["affected_embeddings", "affected_semantic_links", "discoveries"];
}

interface HistoryEntry {
  directory: string;
  manifest: IngestHistoryManifest;
}

interface PreparedChange {
  action: IngestUndoChange["action"];
  title: string;
  filePath: string;
  afterContent: string;
  beforeContent?: string;
  restoredBody?: string;
  afterPath: string;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  const temporary = await Deno.makeTempFile({
    dir: dirname(filePath),
    prefix: ".synthesis-undo-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(temporary, content);
    await Deno.rename(temporary, filePath);
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    }
    throw error;
  }
}

async function hasUndoReceipt(entry: HistoryEntry): Promise<boolean> {
  const receiptPath = `${entry.directory}/undo.json`;
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(receiptPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (stat.isSymlink || !stat.isFile) {
    throw new IngestUndoConflictError(
      "Ingest undo receipt must be a regular file",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(receiptPath));
  } catch {
    throw new IngestUndoConflictError("Ingest undo receipt is invalid");
  }
  const receipt = value as Record<string, unknown>;
  if (
    !receipt || typeof receipt !== "object" ||
    receipt.historyId !== entry.manifest.historyId ||
    typeof receipt.undoneAt !== "string" ||
    !ISO_TIMESTAMP.test(receipt.undoneAt) ||
    Number.isNaN(Date.parse(receipt.undoneAt))
  ) {
    throw new IngestUndoConflictError("Ingest undo receipt is invalid");
  }
  return true;
}

async function latestUndoableHistory(): Promise<HistoryEntry> {
  let root: Deno.FileInfo;
  try {
    root = await Deno.lstat(historyDir());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new IngestUndoNotAvailableError(
        "There is no accepted ingest to undo",
      );
    }
    throw error;
  }
  if (root.isSymlink || !root.isDirectory) {
    throw new IngestUndoConflictError(
      "Vault history must be a regular directory",
    );
  }

  const entries: HistoryEntry[] = [];
  for await (const item of Deno.readDir(historyDir())) {
    if (!item.isDirectory || item.isSymlink) {
      throw new IngestUndoConflictError(
        `Vault history entry ${item.name} must be a directory`,
      );
    }
    const entry = {
      directory: `${historyDir()}/${item.name}`,
      manifest: await readIngestHistoryManifest(`${historyDir()}/${item.name}`),
    };
    if (!await hasUndoReceipt(entry)) entries.push(entry);
  }
  entries.sort((left, right) =>
    right.manifest.appliedAt.localeCompare(left.manifest.appliedAt) ||
    right.manifest.historyId.localeCompare(left.manifest.historyId)
  );
  if (entries.length === 0) {
    throw new IngestUndoNotAvailableError(
      "There is no accepted ingest to undo",
    );
  }
  return entries[0];
}

async function regularMarkdown(
  filePath: string,
  context: string,
): Promise<string> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new IngestUndoConflictError(`${context} is missing`);
    }
    throw error;
  }
  if (stat.isSymlink || !stat.isFile) {
    throw new IngestUndoConflictError(`${context} must be a regular file`);
  }
  return await Deno.readTextFile(filePath);
}

async function prepareChanges(entry: HistoryEntry): Promise<PreparedChange[]> {
  const prepared: PreparedChange[] = [];
  for (let index = 0; index < entry.manifest.changes.length; index++) {
    const change = entry.manifest.changes[index];
    const filePath = `${config.vaultDir}/${change.notePath}`;
    const afterContent = await regularMarkdown(
      filePath,
      `Current wiki page ${change.notePath}`,
    );
    if (await sha256(afterContent) !== change.afterHash) {
      throw new IngestUndoConflictError(
        `Wiki page ${change.notePath} changed after this ingest; undo refused`,
      );
    }
    let currentPage;
    try {
      currentPage = parseWikiPage(afterContent);
    } catch (error) {
      throw new IngestUndoConflictError(
        `Current wiki page ${change.notePath} is invalid: ${errMsg(error)}`,
      );
    }
    if (currentPage.title !== change.pageTitle) {
      throw new IngestUndoConflictError(
        `Current wiki page ${change.notePath} changed title; undo refused`,
      );
    }

    let beforeContent: string | undefined;
    let restoredBody: string | undefined;
    if (change.action !== "new") {
      beforeContent = await regularMarkdown(
        `${entry.directory}/${change.beforeRevision}`,
        `Prior revision for ${change.notePath}`,
      );
      if (await sha256(beforeContent) !== change.beforeHash) {
        throw new IngestUndoConflictError(
          `Prior revision for ${change.notePath} failed its hash check`,
        );
      }
      let beforePage;
      try {
        beforePage = parseWikiPage(beforeContent);
      } catch (error) {
        throw new IngestUndoConflictError(
          `Prior revision for ${change.notePath} is invalid: ${errMsg(error)}`,
        );
      }
      if (beforePage.title !== change.pageTitle) {
        throw new IngestUndoConflictError(
          `Prior revision for ${change.notePath} has the wrong title`,
        );
      }
      restoredBody = beforePage.body;
    }
    prepared.push({
      action: change.action,
      title: change.pageTitle,
      filePath,
      afterContent,
      beforeContent,
      restoredBody,
      afterPath: `${entry.directory}/after/${
        String(index).padStart(3, "0")
      }.md`,
    });
  }
  return prepared;
}

async function restoreAppliedChanges(
  changes: PreparedChange[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const change of changes.toReversed()) {
    try {
      if (change.action === "new") {
        await Deno.rename(change.afterPath, change.filePath);
      } else {
        await replaceFile(change.filePath, change.afterContent);
      }
    } catch (error) {
      failures.push(errMsg(error));
    }
  }
  return failures;
}

/** Undo the newest accepted ingest when its current files still match history. */
export async function undoLastIngest(db: DB): Promise<IngestUndoResult> {
  const entry = await latestUndoableHistory();
  const changes = await prepareChanges(entry);
  const afterDirectory = `${entry.directory}/after`;
  const receiptPath = `${entry.directory}/undo.json`;
  const applied: PreparedChange[] = [];
  try {
    await Deno.mkdir(afterDirectory);
    for (const change of changes) {
      if (change.action === "new") {
        await Deno.rename(change.filePath, change.afterPath);
      } else {
        await Deno.writeTextFile(change.afterPath, change.afterContent, {
          createNew: true,
        });
        await replaceFile(change.filePath, change.beforeContent!);
      }
      applied.push(change);
    }
    await Deno.writeTextFile(
      receiptPath,
      JSON.stringify(
        {
          formatVersion: 1,
          historyId: entry.manifest.historyId,
          undoneAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { createNew: true },
    );
    db.undoIngest(
      entry.manifest.sourceHash,
      changes.map((change) => ({
        action: change.action,
        title: change.title,
        filePath: change.filePath,
        ...(change.restoredBody === undefined
          ? {}
          : { restoredBody: change.restoredBody }),
      })),
    );
  } catch (error) {
    await Deno.remove(receiptPath).catch(() => undefined);
    const failures = await restoreAppliedChanges(applied);
    await Deno.remove(afterDirectory, { recursive: true }).catch(() =>
      undefined
    );
    if (failures.length > 0) {
      throw new Error(
        `Ingest undo failed and file restoration failed: ${
          failures.join("; ")
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  let indexUpdated = true;
  try {
    await rebuildWikiIndex(db);
  } catch {
    indexUpdated = false;
  }
  return {
    historyId: entry.manifest.historyId,
    sourceTitle: entry.manifest.sourceTitle,
    restoredCount: changes.filter((change) => change.action !== "new").length,
    removedCount: changes.filter((change) => change.action === "new").length,
    indexUpdated,
    reset: ["affected_embeddings", "affected_semantic_links", "discoveries"],
  };
}
