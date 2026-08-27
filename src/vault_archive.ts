import { join, resolve } from "node:path";

import type { IngestResult, OriginalSourceFile, SourceType } from "./ingest.ts";

export interface ArchivedVaultSource extends IngestResult {
  contentHash: string;
  archivedAt?: string;
}

export async function ensureRecompileVaultLayout(
  vaultDirectory: string,
): Promise<void> {
  await Promise.all([
    Deno.mkdir(join(vaultDirectory, "notes"), { recursive: true }),
    Deno.mkdir(join(vaultDirectory, "sources"), { recursive: true }),
  ]);
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_TYPES = new Set<SourceType>([
  "youtube",
  "text",
  "markdown",
  "pdf",
]);
const MAX_ARCHIVED_SOURCES = 1_000;
const MAX_LOADED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_HISTORY_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(
  value: unknown,
  context: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > maximumLength || /\p{Cc}/u.test(text)) {
    throw new Error(`${context} is invalid`);
  }
  return text;
}

async function assertOrdinaryFile(
  path: string,
  context: string,
): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`${context} must be an ordinary file`);
  }
}

async function readBoundedBytes(
  path: string,
  context: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  await assertOrdinaryFile(path, context);
  const info = await Deno.stat(path);
  if (info.size > maximumBytes) {
    throw new Error(`${context} exceeds ${maximumBytes} bytes`);
  }
  return await Deno.readFile(path);
}

async function readBoundedText(
  path: string,
  context: string,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedBytes(path, context, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${context} is not valid UTF-8`);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sourceUrl(value: unknown, context: string): string {
  if (value === undefined || value === null || value === "") return "";
  const text = requiredText(value, context, 4_096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${context} must be an absolute URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password
  ) {
    throw new Error(`${context} must be an HTTP(S) URL without credentials`);
  }
  return url.toString();
}

function sourceType(value: unknown, context: string): SourceType {
  if (typeof value !== "string" || !SOURCE_TYPES.has(value as SourceType)) {
    throw new Error(`${context} is invalid`);
  }
  return value as SourceType;
}

function optionalPositiveInteger(
  value: unknown,
  context: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${context} must be a positive integer`);
  }
  return Number(value);
}

async function optionalOriginalFile(
  directory: string,
  type: SourceType,
  metadata: Record<string, unknown>,
): Promise<OriginalSourceFile | undefined> {
  const extension = type === "pdf" ? "pdf" : type === "markdown" ? "md" : "txt";
  const path = join(directory, `original.${extension}`);
  let exists = true;
  try {
    await Deno.lstat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    exists = false;
  }

  const declaresOriginal = metadata.originalFileName !== undefined ||
    metadata.mediaType !== undefined;
  if (!exists && declaresOriginal) {
    throw new Error(
      `Archived source ${directory} is missing its original file`,
    );
  }
  if (!exists) return undefined;
  if (!declaresOriginal) {
    throw new Error(
      `Archived source ${directory} has unrecorded original bytes`,
    );
  }
  return {
    fileName: requiredText(
      metadata.originalFileName,
      "Archived source originalFileName",
      255,
    ),
    mediaType: requiredText(
      metadata.mediaType,
      "Archived source mediaType",
      255,
    ),
    bytes: await readBoundedBytes(
      path,
      "Archived original source",
      MAX_ORIGINAL_BYTES,
    ),
  };
}

async function readArchivedSource(
  directory: string,
  directoryHash: string,
): Promise<ArchivedVaultSource> {
  const metadataText = await readBoundedText(
    join(directory, "meta.json"),
    "Archived source metadata",
    MAX_METADATA_BYTES,
  );
  let metadata: Record<string, unknown>;
  try {
    metadata = asRecord(JSON.parse(metadataText), "Archived source metadata");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid metadata for source ${directoryHash}: ${message}`);
  }
  const contentHash = requiredText(
    metadata.contentHash,
    "Archived source contentHash",
    64,
  );
  if (!SHA256_PATTERN.test(contentHash) || contentHash !== directoryHash) {
    throw new Error(
      `Archived source ${directoryHash} has a mismatched content hash`,
    );
  }
  const type = sourceType(metadata.sourceType, "Archived source sourceType");
  const transcriptBytes = await readBoundedBytes(
    join(directory, "source.txt"),
    "Archived source text",
    MAX_TRANSCRIPT_BYTES,
  );
  let transcript: string;
  try {
    transcript = new TextDecoder("utf-8", { fatal: true }).decode(
      transcriptBytes,
    );
  } catch {
    throw new Error(`Archived source ${directoryHash} text is not valid UTF-8`);
  }
  if (!transcript.trim()) {
    throw new Error(`Archived source ${directoryHash} text is empty`);
  }
  const originalFile = await optionalOriginalFile(directory, type, metadata);
  const computedHash = await sha256(originalFile?.bytes ?? transcriptBytes);
  if (computedHash !== contentHash) {
    throw new Error(`Archived source ${directoryHash} failed its hash check`);
  }
  const pageCount = optionalPositiveInteger(
    metadata.pageCount,
    "Archived source pageCount",
  );
  if (type === "pdf" && (!originalFile || pageCount === undefined)) {
    throw new Error(
      `Archived PDF source ${directoryHash} is missing original bytes or page count`,
    );
  }
  return {
    contentHash,
    transcript,
    title: requiredText(metadata.title, "Archived source title", 500),
    sourceUrl: sourceUrl(metadata.sourceUrl, "Archived source sourceUrl"),
    sourceType: type,
    ...(originalFile ? { originalFile } : {}),
    ...(pageCount === undefined ? {} : { pageCount }),
  };
}

async function historyOrder(
  vaultDirectory: string,
): Promise<Map<string, string>> {
  const historyDirectory = join(vaultDirectory, "history");
  const appliedAtByHash = new Map<string, string>();
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(historyDirectory)) {
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return appliedAtByHash;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    const manifestPath = join(historyDirectory, entry.name, "manifest.json");
    let text: string;
    try {
      text = await readBoundedText(
        manifestPath,
        "Ingest history manifest",
        MAX_HISTORY_MANIFEST_BYTES,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = asRecord(JSON.parse(text), "Ingest history manifest");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ingest history ${entry.name}: ${message}`);
    }
    if (
      typeof manifest.sourceHash !== "string" ||
      !SHA256_PATTERN.test(manifest.sourceHash) ||
      typeof manifest.appliedAt !== "string" ||
      !ISO_TIMESTAMP_PATTERN.test(manifest.appliedAt) ||
      Number.isNaN(Date.parse(manifest.appliedAt))
    ) {
      throw new Error(`Invalid ingest history identity in ${entry.name}`);
    }
    const previous = appliedAtByHash.get(manifest.sourceHash);
    if (!previous || manifest.appliedAt < previous) {
      appliedAtByHash.set(manifest.sourceHash, manifest.appliedAt);
    }
  }
  return appliedAtByHash;
}

export async function loadArchivedVaultSources(
  vaultDirectory: string,
): Promise<ArchivedVaultSource[]> {
  const root = resolve(vaultDirectory);
  const rootInfo = await Deno.lstat(root);
  if (!rootInfo.isDirectory || rootInfo.isSymlink) {
    throw new Error("Source vault must be an ordinary directory");
  }
  const sourcesDirectory = join(root, "sources");
  const sourcesInfo = await Deno.lstat(sourcesDirectory);
  if (!sourcesInfo.isDirectory || sourcesInfo.isSymlink) {
    throw new Error("Source vault sources/ must be an ordinary directory");
  }

  const sourceDirectories: Array<{ name: string; path: string }> = [];
  for await (const entry of Deno.readDir(sourcesDirectory)) {
    if (
      !entry.isDirectory || entry.isSymlink || !SHA256_PATTERN.test(entry.name)
    ) {
      throw new Error(`Unexpected entry in source archive: ${entry.name}`);
    }
    sourceDirectories.push({
      name: entry.name,
      path: join(sourcesDirectory, entry.name),
    });
    if (sourceDirectories.length > MAX_ARCHIVED_SOURCES) {
      throw new Error(
        `Source archive exceeds ${MAX_ARCHIVED_SOURCES} sources`,
      );
    }
  }
  if (sourceDirectories.length === 0) {
    throw new Error("Source vault contains no archived sources");
  }

  const order = await historyOrder(root);
  const sources: ArchivedVaultSource[] = [];
  let loadedBytes = 0;
  for (const { name, path } of sourceDirectories) {
    const source = await readArchivedSource(path, name);
    loadedBytes += source.transcript.length * 2 +
      (source.originalFile?.bytes.byteLength ?? 0);
    if (loadedBytes > MAX_LOADED_ARCHIVE_BYTES) {
      throw new Error(
        `Source archive exceeds the ${MAX_LOADED_ARCHIVE_BYTES}-byte in-memory recompilation limit`,
      );
    }
    const archivedAt = order.get(name);
    sources.push(archivedAt ? { ...source, archivedAt } : source);
  }
  return sources.sort((left, right) => {
    if (left.archivedAt && right.archivedAt) {
      const byTime = left.archivedAt.localeCompare(right.archivedAt);
      if (byTime !== 0) return byTime;
    } else if (left.archivedAt) {
      return -1;
    } else if (right.archivedAt) {
      return 1;
    }
    return left.contentHash.localeCompare(right.contentHash);
  });
}
