import { relative } from "node:path";

import { notesDir, sourcesDir } from "../app/config.ts";
import type { CatalogueNote, CatalogueSource, DB } from "../catalogue/db.ts";
import { errMsg } from "../shared/utils.ts";
import {
  historyDir,
  type IngestHistoryAction,
  validateIngestHistoryManifest,
} from "./ingest_history.ts";
import { ensureVaultManifest } from "./vault_manifest.ts";
import {
  findSourceReferenceHashes,
  parseWikiPage,
  renderWikiIndex,
  type WikiPage,
} from "../wiki/wiki.ts";
import { ensureWikiSchema } from "../wiki/wiki_schema.ts";

const SOURCE_HASH = /^[a-f0-9]{64}$/;
const SOURCE_TYPES = new Set(["youtube", "text", "markdown", "pdf"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PreparedNote extends CatalogueNote {
  page: WikiPage;
}

type HistoryActions = Map<string, Map<string, IngestHistoryAction>>;

export interface VaultRebuildResult {
  sourceCount: number;
  noteCount: number;
  provenanceCount: number;
  reset: [
    "embeddings",
    "semantic_links",
    "proposals",
    "discovery_candidates",
    "discoveries",
  ];
}

export class VaultRebuildError extends Error {}

function requiredText(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${context} must be text`);
  const result = value.trim();
  if (!result || result.length > maxLength || /\p{Cc}/u.test(result)) {
    throw new Error(`${context} is invalid`);
  }
  return result;
}

async function readUtf8(filePath: string, context: string): Promise<string> {
  try {
    return decoder.decode(await Deno.readFile(filePath));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${context} must be valid UTF-8`);
    }
    throw error;
  }
}

async function regularFile(filePath: string, context: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${context} is missing`);
    }
    throw error;
  }
  if (stat.isSymlink || !stat.isFile) {
    throw new Error(`${context} must be a regular file`);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sourceUrl(value: unknown, context: string): string | null {
  if (value === "" || value === null) return null;
  const candidate = requiredText(value, `${context}.sourceUrl`, 2_048);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${context}.sourceUrl must be an absolute URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password
  ) {
    throw new Error(`${context}.sourceUrl must be an HTTP(S) URL`);
  }
  return url.href;
}

async function parseSource(directory: string): Promise<CatalogueSource> {
  const contentHash = directory.slice(directory.lastIndexOf("/") + 1);
  if (!SOURCE_HASH.test(contentHash)) {
    throw new Error(
      `Source directory has invalid SHA-256 name: ${contentHash}`,
    );
  }
  const context = `Source ${contentHash}`;
  const metaPath = `${directory}/meta.json`;
  const rawPath = `${directory}/source.txt`;
  const summaryPath = `${directory}/summary.md`;
  await regularFile(metaPath, `${context} metadata`);
  await regularFile(rawPath, `${context} transcript`);
  await regularFile(summaryPath, `${context} summary`);

  let metadata: unknown;
  try {
    metadata = JSON.parse(await readUtf8(metaPath, `${context} metadata`));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${context} metadata contains invalid JSON`);
    }
    throw error;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${context} metadata must be an object`);
  }
  const meta = metadata as Record<string, unknown>;
  if (meta.contentHash !== contentHash) {
    throw new Error(`${context} metadata hash does not match its directory`);
  }
  const title = requiredText(meta.title, `${context}.title`, 500);
  const type = requiredText(meta.sourceType, `${context}.sourceType`, 20);
  if (!SOURCE_TYPES.has(type)) {
    throw new Error(`${context}.sourceType is unsupported`);
  }
  const url = sourceUrl(meta.sourceUrl, context);
  const summary = (await readUtf8(summaryPath, `${context} summary`)).trim();
  if (!summary) throw new Error(`${context} summary must not be empty`);
  await readUtf8(rawPath, `${context} transcript`);

  let hashPath = rawPath;
  const originalFileName = meta.originalFileName;
  const allowedFiles = new Set(["meta.json", "source.txt", "summary.md"]);
  if (originalFileName !== undefined) {
    requiredText(originalFileName, `${context}.originalFileName`, 1_024);
    requiredText(meta.mediaType, `${context}.mediaType`, 200);
    const extension = type === "pdf"
      ? "pdf"
      : type === "markdown"
      ? "md"
      : "txt";
    const originalName = `original.${extension}`;
    hashPath = `${directory}/${originalName}`;
    allowedFiles.add(originalName);
    await regularFile(hashPath, `${context} original file`);
  } else if (type === "pdf") {
    throw new Error(`${context} PDF metadata must identify its original file`);
  }
  if (type === "pdf") {
    const pageCount = Number(meta.pageCount);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new Error(`${context}.pageCount is invalid`);
    }
  }

  for await (const entry of Deno.readDir(directory)) {
    if (!allowedFiles.has(entry.name)) {
      throw new Error(`${context} contains unsupported file ${entry.name}`);
    }
    await regularFile(`${directory}/${entry.name}`, `${context}/${entry.name}`);
  }
  if (await sha256(await Deno.readFile(hashPath)) !== contentHash) {
    throw new Error(`${context} content does not match its SHA-256`);
  }

  return {
    contentHash,
    title,
    sourceUrl: url,
    sourceType: type,
    filePath: rawPath,
    summary,
  };
}

async function readSources(): Promise<CatalogueSource[]> {
  let root: Deno.FileInfo;
  try {
    root = await Deno.lstat(sourcesDir());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (root.isSymlink || !root.isDirectory) {
    throw new Error("Vault sources must be a regular directory");
  }
  const directories: string[] = [];
  for await (const entry of Deno.readDir(sourcesDir())) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error(`Vault source entry ${entry.name} must be a directory`);
    }
    directories.push(`${sourcesDir()}/${entry.name}`);
  }
  directories.sort((left, right) => left.localeCompare(right, "en-GB"));
  const sources: CatalogueSource[] = [];
  for (const directory of directories) {
    sources.push(await parseSource(directory));
  }
  return sources;
}

async function readHistoryActions(): Promise<HistoryActions> {
  let root: Deno.FileInfo;
  try {
    root = await Deno.lstat(historyDir());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Map();
    throw error;
  }
  if (root.isSymlink || !root.isDirectory) {
    throw new Error("Vault history must be a regular directory");
  }

  const directoryNames: string[] = [];
  for await (const entry of Deno.readDir(historyDir())) {
    if (!entry.isDirectory || entry.isSymlink) {
      throw new Error(`Vault history entry ${entry.name} must be a directory`);
    }
    directoryNames.push(entry.name);
  }
  directoryNames.sort((left, right) => left.localeCompare(right, "en-GB"));

  const actions: HistoryActions = new Map();
  for (const directoryName of directoryNames) {
    const manifestPath = `${historyDir()}/${directoryName}/manifest.json`;
    await regularFile(manifestPath, `History ${directoryName} manifest`);
    let value: unknown;
    try {
      value = JSON.parse(
        await readUtf8(manifestPath, `History ${directoryName} manifest`),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `History ${directoryName} manifest contains invalid JSON`,
        );
      }
      throw error;
    }
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).operation !== "ingest"
    ) {
      continue;
    }
    const manifest = validateIngestHistoryManifest(value);
    for (const change of manifest.changes) {
      const sourceActions = actions.get(change.notePath) ?? new Map();
      const existing = sourceActions.get(manifest.sourceHash);
      if (existing !== undefined && existing !== change.action) {
        throw new Error(
          `History records conflicting actions for ${change.notePath} and source ${manifest.sourceHash}`,
        );
      }
      sourceActions.set(manifest.sourceHash, change.action);
      actions.set(change.notePath, sourceActions);
    }
  }
  return actions;
}

async function collectNoteFiles(
  directory: string,
  files: string[],
): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (stat.isSymlink) throw new Error("Vault notes must not contain symlinks");
  if (stat.isFile) {
    if (directory.endsWith(".md")) files.push(directory);
    return;
  }
  if (!stat.isDirectory) {
    throw new Error("Vault notes must contain only files and directories");
  }
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) names.push(entry.name);
  names.sort((left, right) => left.localeCompare(right, "en-GB"));
  for (const name of names) {
    await collectNoteFiles(`${directory}/${name}`, files);
  }
}

async function readNotes(
  sourceHashes: ReadonlySet<string>,
  historyActions: HistoryActions,
): Promise<PreparedNote[]> {
  const files: string[] = [];
  await collectNoteFiles(notesDir(), files);
  const notes: PreparedNote[] = [];
  const titles = new Map<string, string>();
  for (const filePath of files) {
    const archivePath = relative(notesDir(), filePath).replaceAll("\\", "/");
    if (archivePath === "index.md" || archivePath === "log.md") continue;
    const markdown = await readUtf8(filePath, `Wiki page ${archivePath}`);
    let page: WikiPage;
    try {
      page = parseWikiPage(markdown);
    } catch (error) {
      throw new Error(`Invalid wiki page ${archivePath}: ${errMsg(error)}`);
    }
    const titleKey = page.title.toLocaleLowerCase("en-GB");
    const duplicate = titles.get(titleKey);
    if (duplicate) {
      throw new Error(
        `Wiki title "${page.title}" is duplicated in ${duplicate} and ${archivePath}`,
      );
    }
    titles.set(titleKey, archivePath);

    const provenance = findSourceReferenceHashes(markdown);
    if (provenance.length === 0) {
      throw new Error(`Wiki page ${archivePath} has no source provenance`);
    }
    for (const hash of provenance) {
      if (!sourceHashes.has(hash)) {
        throw new Error(
          `Wiki page ${archivePath} references missing source ${hash}`,
        );
      }
    }
    notes.push({
      title: page.title,
      filePath,
      body: page.body,
      sourceHashes: provenance,
      sourceActions: Object.fromEntries(
        provenance.map((hash) => [
          hash,
          historyActions.get(`notes/${archivePath}`)?.get(hash) ?? "reference",
        ]),
      ),
      page,
    });
  }

  for (const note of notes) {
    for (const link of note.page.links) {
      if (!titles.has(link.toLocaleLowerCase("en-GB"))) {
        throw new Error(
          `Wiki page "${note.title}" links to missing page "${link}"`,
        );
      }
    }
  }
  return notes;
}

async function replaceIndex(notes: PreparedNote[]): Promise<void> {
  await Deno.mkdir(notesDir(), { recursive: true });
  const indexPath = `${notesDir()}/index.md`;
  const temporary = await Deno.makeTempFile({
    dir: notesDir(),
    prefix: ".synthesis-index-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(
      temporary,
      renderWikiIndex(notes.map(({ page }) => ({
        title: page.title,
        type: page.type,
        summary: page.body.split(/\n\s*\n/, 1)[0],
      }))),
    );
    await Deno.rename(temporary, indexPath);
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    }
    throw error;
  }
}

/** Rebuild provider-independent SQLite catalogue state from authoritative files. */
export async function rebuildVaultCatalogue(
  db: DB,
): Promise<VaultRebuildResult> {
  let sources: CatalogueSource[];
  let notes: PreparedNote[];
  try {
    await ensureVaultManifest();
    await ensureWikiSchema();
    sources = await readSources();
    const historyActions = await readHistoryActions();
    notes = await readNotes(
      new Set(sources.map((source) => source.contentHash)),
      historyActions,
    );
  } catch (error) {
    throw new VaultRebuildError(`Vault preflight failed: ${errMsg(error)}`);
  }
  await replaceIndex(notes);
  db.maintenance.replaceCatalogue(sources, notes);
  return {
    sourceCount: sources.length,
    noteCount: notes.length,
    provenanceCount: notes.reduce(
      (count, note) => count + note.sourceHashes.length,
      0,
    ),
    reset: [
      "embeddings",
      "semantic_links",
      "proposals",
      "discovery_candidates",
      "discoveries",
    ],
  };
}
