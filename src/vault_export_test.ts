import assert from "node:assert/strict";
import { dirname } from "node:path";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import { exportVault } from "./vault_export.ts";
import { rebuildVaultCatalog } from "./vault_rebuild.ts";
import { renderWikiPage } from "./wiki.ts";

const decoder = new TextDecoder();
const TAR_BLOCK_SIZE = 512;

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

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarOctal(bytes: Uint8Array): number {
  const value = tarString(bytes).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const expectedChecksum = tarOctal(header.subarray(148, 156));
    const checksumHeader = header.slice();
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    assert.equal(actualChecksum, expectedChecksum, "tar header checksum");

    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const contentStart = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentStart + size;
    assert.ok(contentEnd <= archive.length, "tar entry must be complete");
    files.set(path, archive.slice(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return files;
}

Deno.test({
  name: "vault export streams the authoritative portable state as valid tar",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-export-test-" });
    const originalVaultDir = config.vaultDir;
    let restoredDir: string | undefined;
    let restoredDb: DB | undefined;
    try {
      config.vaultDir = dir;
      const transcript = "Evidence retained for portable restoration.\n";
      const sourceHash = await sha256(transcript);
      const noteMarkdown = renderWikiPage({
        title: "Alpha evidence",
        type: "concept",
        body: "Portable knowledge remains searchable after restoration.",
        tags: ["portable"],
        links: [],
      }, [{ title: "Source", contentHash: sourceHash }]);
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      await Deno.mkdir(`${dir}/sources/${sourceHash}`, { recursive: true });
      await Deno.mkdir(`${dir}/history/revision-1`, { recursive: true });
      await Deno.writeTextFile(`${dir}/notes/alpha.md`, noteMarkdown);
      await Deno.writeTextFile(
        `${dir}/sources/${sourceHash}/meta.json`,
        JSON.stringify(
          {
            contentHash: sourceHash,
            title: "Source",
            sourceUrl: "",
            sourceType: "text",
          },
          null,
          2,
        ) + "\n",
      );
      await Deno.writeTextFile(
        `${dir}/sources/${sourceHash}/source.txt`,
        transcript,
      );
      await Deno.writeTextFile(
        `${dir}/sources/${sourceHash}/summary.md`,
        "Portable source summary.\n",
      );
      await Deno.writeTextFile(
        `${dir}/history/revision-1/manifest.json`,
        '{"revision":1}\n',
      );
      await Deno.writeTextFile(`${dir}/synthesis.db`, "must not be exported");

      const exported = await exportVault();
      const archive = new Uint8Array(
        await new Response(exported.stream).arrayBuffer(),
      );
      const files = readTar(archive);
      const paths = [...files.keys()];

      assert.equal(exported.fileCount, 7);
      assert.deepEqual(paths, [
        "history/revision-1/manifest.json",
        "notes/alpha.md",
        "schema.md",
        `sources/${sourceHash}/meta.json`,
        `sources/${sourceHash}/source.txt`,
        `sources/${sourceHash}/summary.md`,
        "vault.json",
      ]);
      assert.equal(decoder.decode(files.get("notes/alpha.md")), noteMarkdown);
      assert.equal(
        decoder.decode(files.get(`sources/${sourceHash}/source.txt`)),
        transcript,
      );
      assert.equal(files.has("synthesis.db"), false);
      assert.equal(
        archive.subarray(-TAR_BLOCK_SIZE * 2).every((byte) => byte === 0),
        true,
      );

      restoredDir = await Deno.makeTempDir({
        prefix: "synthesis-restored-test-",
      });
      for (const [path, content] of files) {
        assert.doesNotMatch(path, /(?:^|\/)\.\.(?:\/|$)/);
        assert.equal(path.startsWith("/"), false);
        const target = `${restoredDir}/${path}`;
        await Deno.mkdir(dirname(target), { recursive: true });
        await Deno.writeFile(target, content, { createNew: true });
      }
      config.vaultDir = restoredDir;
      restoredDb = new DB(`${restoredDir}/synthesis.db`);
      const rebuilt = await rebuildVaultCatalog(restoredDb);
      assert.equal(rebuilt.sourceCount, 1);
      assert.equal(rebuilt.noteCount, 1);
      assert.equal(
        restoredDb.getNoteByExactTitle("Alpha evidence")?.title,
        "Alpha evidence",
      );
      assert.equal(restoredDb.searchKeyword("searchable").length, 1);
    } finally {
      restoredDb?.close();
      config.vaultDir = originalVaultDir;
      await Deno.remove(dir, { recursive: true });
      if (restoredDir) await Deno.remove(restoredDir, { recursive: true });
    }
  },
});
