import { relative } from "node:path";

import { config } from "../app/config.ts";
import { ensureVaultManifest } from "./vault_manifest.ts";
import { ensureWikiSchema } from "../wiki/wiki_schema.ts";

interface ExportFile {
  archivePath: string;
  filePath: string;
}

export interface VaultExport {
  fileCount: number;
  stream: ReadableStream<Uint8Array>;
}

const encoder = new TextEncoder();
const TAR_BLOCK_SIZE = 512;

function safeArchivePath(filePath: string): string {
  const path = relative(config.vaultDir, filePath).replaceAll("\\", "/");
  if (
    !path || path.startsWith("../") || path.includes("/../") ||
    path.startsWith("/") || /\p{Cc}/u.test(path)
  ) {
    throw new Error("Vault export encountered an unsafe path");
  }
  return path;
}

async function collectFiles(path: string, files: ExportFile[]): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (stat.isSymlink) {
    throw new Error("Vault export does not follow symbolic links");
  }
  if (stat.isFile) {
    files.push({ archivePath: safeArchivePath(path), filePath: path });
    return;
  }
  if (!stat.isDirectory) {
    throw new Error("Vault export supports only regular files and directories");
  }
  const entries = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry.name);
  entries.sort((left, right) => left.localeCompare(right, "en-GB"));
  for (const entry of entries) await collectFiles(`${path}/${entry}`, files);
}

function writeAscii(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) {
    throw new Error("Vault export tar field is too long");
  }
  header.set(bytes, offset);
}

function writeOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8).padStart(length - 1, "0") + "\0";
  writeAscii(header, offset, length, octal);
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      encoder.encode(name).length <= 100 && encoder.encode(prefix).length <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Vault export path is too long for tar: ${path}`);
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(path);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, "0");
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(
    header,
    148,
    8,
    checksum.toString(8).padStart(6, "0") + "\0 ",
  );
  return header;
}

async function* tarChunks(files: ExportFile[]): AsyncGenerator<Uint8Array> {
  for (const file of files) {
    const content = await Deno.readFile(file.filePath);
    yield tarHeader(file.archivePath, content.length);
    if (content.length > 0) yield content;
    const padding = (TAR_BLOCK_SIZE - content.length % TAR_BLOCK_SIZE) %
      TAR_BLOCK_SIZE;
    if (padding > 0) yield new Uint8Array(padding);
  }
  yield new Uint8Array(TAR_BLOCK_SIZE * 2);
}

async function snapshotStream(
  files: ExportFile[],
): Promise<ReadableStream<Uint8Array>> {
  const snapshotPath = await Deno.makeTempFile({
    prefix: "synthesis-vault-export-",
    suffix: ".tar",
  });
  let output: Deno.FsFile | undefined;
  try {
    output = await Deno.open(snapshotPath, { write: true, truncate: true });
    for await (const chunk of tarChunks(files)) {
      let offset = 0;
      while (offset < chunk.length) {
        const written = await output.write(chunk.subarray(offset));
        if (written === 0) {
          throw new Error("Vault export snapshot write made no progress");
        }
        offset += written;
      }
    }
    await output.sync();
    output.close();
    output = undefined;
  } catch (error) {
    output?.close();
    await Deno.remove(snapshotPath).catch(() => undefined);
    throw error;
  }

  let input: Deno.FsFile;
  try {
    input = await Deno.open(snapshotPath, { read: true });
  } catch (error) {
    await Deno.remove(snapshotPath).catch(() => undefined);
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    input.close();
    await Deno.remove(snapshotPath).catch(() => undefined);
  };
  return new ReadableStream({
    async pull(controller) {
      const buffer = new Uint8Array(64 * 1024);
      try {
        const read = await input.read(buffer);
        if (read === null) {
          controller.close();
          await close();
        } else controller.enqueue(buffer.subarray(0, read));
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel() {
      await close();
    },
  });
}

/** Stream a portable export of authoritative vault files. */
export async function exportVault(): Promise<VaultExport> {
  await ensureVaultManifest();
  await ensureWikiSchema();
  const files: ExportFile[] = [];
  await collectFiles(`${config.vaultDir}/vault.json`, files);
  await collectFiles(`${config.vaultDir}/schema.md`, files);
  for (const directory of ["notes", "sources", "history"]) {
    await collectFiles(`${config.vaultDir}/${directory}`, files);
  }
  files.sort((left, right) =>
    left.archivePath.localeCompare(right.archivePath, "en-GB")
  );
  return {
    fileCount: files.length,
    stream: await snapshotStream(files),
  };
}
