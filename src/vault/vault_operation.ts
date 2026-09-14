import { dirname, relative, resolve } from "node:path";

const JOURNAL_DIRECTORY = ".synthesis-journal";
const MAX_CHANGES = 128;
const MAX_CONTENT_LENGTH = 2_000_000;
const MAX_TOTAL_CONTENT_LENGTH = 12_000_000;
const MAX_JOURNAL_BYTES = 24_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_PATH =
  /^(?:notes\/[^/\\]+\.md|history\/(?!\.{1,2}\/)[^/\\]+\/(?:manifest\.json|before\/\d{3}\.md))$/;

export interface VaultOperationChange {
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
}

interface StoredVaultOperationChange {
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
}

interface StoredVaultOperation {
  formatVersion: 1;
  operationId: string;
  operation: "ingest";
  createdAt: string;
  changes: StoredVaultOperationChange[];
}

export interface PreparedVaultOperation {
  journalPath: string;
  vaultDirectory: string;
  stored: StoredVaultOperation;
}

export class VaultOperationConflictError extends Error {}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function writeAll(file: Deno.FsFile, content: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const written = await file.write(content.subarray(offset));
    if (written === 0) {
      throw new Error("Vault operation write made no progress");
    }
    offset += written;
  }
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(filePath), { recursive: true });
  const temporary = await Deno.makeTempFile({
    dir: dirname(filePath),
    prefix: ".synthesis-operation-",
    suffix: ".tmp",
  });
  try {
    const file = await Deno.open(temporary, { write: true, truncate: true });
    try {
      await writeAll(file, new TextEncoder().encode(content));
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(temporary, filePath);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}

function storedPath(vaultDirectory: string, filePath: string): string {
  const root = resolve(vaultDirectory);
  const target = resolve(filePath);
  const path = relative(root, target).replaceAll("\\", "/");
  if (!ALLOWED_PATH.test(path) || path.startsWith("../")) {
    throw new Error("Vault operation path is outside supported vault files");
  }
  return path;
}

function validateContent(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Vault operation ${name} is invalid`);
  }
  return value;
}

function validateStoredVaultOperation(value: unknown): StoredVaultOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vault operation journal must contain an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.formatVersion !== 1 || record.operation !== "ingest" ||
    typeof record.operationId !== "string" ||
    !UUID_PATTERN.test(record.operationId) ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    !Array.isArray(record.changes) || record.changes.length < 1 ||
    record.changes.length > MAX_CHANGES
  ) {
    throw new Error("Vault operation journal metadata is invalid");
  }
  const paths = new Set<string>();
  let totalLength = 0;
  const changes = record.changes.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Vault operation change ${index} is invalid`);
    }
    const change = value as Record<string, unknown>;
    if (
      typeof change.path !== "string" || !ALLOWED_PATH.test(change.path) ||
      paths.has(change.path)
    ) {
      throw new Error(`Vault operation change ${index} path is invalid`);
    }
    paths.add(change.path);
    const beforeContent = validateContent(
      change.beforeContent,
      `change ${index} beforeContent`,
    );
    const afterContent = validateContent(
      change.afterContent,
      `change ${index} afterContent`,
    );
    if (beforeContent === afterContent) {
      throw new Error(`Vault operation change ${index} has no effect`);
    }
    totalLength += (beforeContent?.length ?? 0) + (afterContent?.length ?? 0);
    return { path: change.path, beforeContent, afterContent };
  });
  if (totalLength > MAX_TOTAL_CONTENT_LENGTH) {
    throw new Error("Vault operation journal content is too large");
  }
  return {
    formatVersion: 1,
    operationId: record.operationId,
    operation: "ingest",
    createdAt: record.createdAt,
    changes,
  };
}

async function writeJournal(
  journalPath: string,
  stored: StoredVaultOperation,
): Promise<void> {
  const temporary = `${journalPath}.tmp`;
  const content = new TextEncoder().encode(
    JSON.stringify(stored, null, 2) + "\n",
  );
  if (content.length > MAX_JOURNAL_BYTES) {
    throw new Error("Vault operation journal is too large");
  }
  try {
    const file = await Deno.open(temporary, {
      createNew: true,
      write: true,
    });
    try {
      await writeAll(file, content);
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(temporary, journalPath);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertNoPendingRecovery(vaultDirectory: string): Promise<void> {
  const directory = `${vaultDirectory}/${JOURNAL_DIRECTORY}`;
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (info.isSymlink || !info.isDirectory) {
    throw new Error("Vault operation journal must be an ordinary directory");
  }
  for await (const _entry of Deno.readDir(directory)) {
    throw new Error(
      "The vault has a pending recovery operation; restart Synthesis before making more changes",
    );
  }
}

export async function prepareVaultOperation(
  vaultDirectory: string,
  changes: VaultOperationChange[],
): Promise<PreparedVaultOperation> {
  await assertNoPendingRecovery(vaultDirectory);
  const operationId = crypto.randomUUID();
  const stored = validateStoredVaultOperation({
    formatVersion: 1,
    operationId,
    operation: "ingest",
    createdAt: new Date().toISOString(),
    changes: changes.map((change) => ({
      path: storedPath(vaultDirectory, change.filePath),
      beforeContent: change.beforeContent,
      afterContent: change.afterContent,
    })),
  });
  for (const change of stored.changes) {
    const current = await readIfPresent(`${vaultDirectory}/${change.path}`);
    if (current !== change.beforeContent) {
      throw new VaultOperationConflictError(
        `Vault file ${change.path} changed before the operation was prepared`,
      );
    }
  }
  const directory = `${vaultDirectory}/${JOURNAL_DIRECTORY}`;
  await Deno.mkdir(directory, { recursive: true });
  const journalPath = `${directory}/${operationId}.json`;
  await writeJournal(journalPath, stored);
  return { journalPath, vaultDirectory, stored };
}

async function applyStoredOperation(
  vaultDirectory: string,
  stored: StoredVaultOperation,
): Promise<void> {
  for (const change of stored.changes) {
    const current = await readIfPresent(`${vaultDirectory}/${change.path}`);
    if (current !== change.beforeContent && current !== change.afterContent) {
      throw new VaultOperationConflictError(
        `Vault file ${change.path} conflicts with pending recovery`,
      );
    }
  }
  for (const change of stored.changes) {
    const filePath = `${vaultDirectory}/${change.path}`;
    const current = await readIfPresent(filePath);
    if (current === change.afterContent) continue;
    if (current !== change.beforeContent) {
      throw new VaultOperationConflictError(
        `Vault file ${change.path} conflicts with pending recovery`,
      );
    }
    if (change.afterContent === null) await Deno.remove(filePath);
    else await replaceFile(filePath, change.afterContent);
  }
}

export async function applyVaultOperation(
  prepared: PreparedVaultOperation,
): Promise<void> {
  await applyStoredOperation(prepared.vaultDirectory, prepared.stored);
}

async function removeEmptyParentDirectories(
  vaultDirectory: string,
  stored: StoredVaultOperation,
): Promise<void> {
  const directories = new Set(
    stored.changes.map((change) => dirname(`${vaultDirectory}/${change.path}`)),
  );
  for (
    const directory of [...directories].sort((a, b) => b.length - a.length)
  ) {
    if (!relative(`${vaultDirectory}/history`, directory).startsWith("..")) {
      await removeDirectoryIfEmpty(directory);
    }
  }
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(directory)) return;
    await Deno.remove(directory);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function rollbackVaultOperation(
  prepared: PreparedVaultOperation,
): Promise<void> {
  for (const change of prepared.stored.changes) {
    const current = await readIfPresent(
      `${prepared.vaultDirectory}/${change.path}`,
    );
    if (current !== change.beforeContent && current !== change.afterContent) {
      throw new VaultOperationConflictError(
        `Vault file ${change.path} conflicts with operation rollback`,
      );
    }
  }
  for (const change of prepared.stored.changes.toReversed()) {
    const filePath = `${prepared.vaultDirectory}/${change.path}`;
    const current = await readIfPresent(filePath);
    if (current === change.beforeContent) continue;
    if (current !== change.afterContent) {
      throw new VaultOperationConflictError(
        `Vault file ${change.path} conflicts with operation rollback`,
      );
    }
    if (change.beforeContent === null) {
      await Deno.remove(filePath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    } else await replaceFile(filePath, change.beforeContent);
  }
  await removeEmptyParentDirectories(prepared.vaultDirectory, prepared.stored);
}

export async function completeVaultOperation(
  prepared: PreparedVaultOperation,
): Promise<void> {
  await Deno.remove(prepared.journalPath);
  await removeDirectoryIfEmpty(dirname(prepared.journalPath));
}

export async function recoverPendingVaultOperations(
  vaultDirectory: string,
): Promise<PreparedVaultOperation[]> {
  const directory = `${vaultDirectory}/${JOURNAL_DIRECTORY}`;
  let directoryInfo: Deno.FileInfo;
  try {
    directoryInfo = await Deno.lstat(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (directoryInfo.isSymlink || !directoryInfo.isDirectory) {
    throw new Error("Vault operation journal must be an ordinary directory");
  }
  let names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      const temporaryId = entry.name.endsWith(".json.tmp")
        ? entry.name.slice(0, -9)
        : "";
      if (entry.isFile && !entry.isSymlink && UUID_PATTERN.test(temporaryId)) {
        await Deno.remove(`${directory}/${entry.name}`);
        continue;
      }
      if (
        !entry.isFile || entry.isSymlink ||
        !UUID_PATTERN.test(entry.name.slice(0, -5)) ||
        !entry.name.endsWith(".json")
      ) {
        throw new Error(
          "Vault operation journal directory contains an invalid entry",
        );
      }
      names.push(entry.name);
    }
  } catch (error) {
    throw error;
  }
  names = names.sort();
  const recovered: PreparedVaultOperation[] = [];
  for (const name of names) {
    const journalPath = `${directory}/${name}`;
    const journalInfo = await Deno.lstat(journalPath);
    if (
      !journalInfo.isFile || journalInfo.isSymlink ||
      journalInfo.size > MAX_JOURNAL_BYTES
    ) {
      throw new Error("Vault operation journal file is invalid");
    }
    const stored = validateStoredVaultOperation(
      JSON.parse(await Deno.readTextFile(journalPath)),
    );
    if (`${stored.operationId}.json` !== name) {
      throw new Error("Vault operation journal filename does not match its ID");
    }
    await applyStoredOperation(vaultDirectory, stored);
    recovered.push({ journalPath, vaultDirectory, stored });
  }
  return recovered;
}
