import assert from "node:assert/strict";
import { join } from "node:path";

import {
  ensureRecompileVaultLayout,
  loadArchivedVaultSources,
} from "./vault_archive.ts";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function writeSource(
  vault: string,
  title: string,
  transcript: string,
): Promise<string> {
  const contentHash = await sha256(transcript);
  const directory = join(vault, "sources", contentHash);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(join(directory, "source.txt"), transcript);
  await Deno.writeTextFile(
    join(directory, "meta.json"),
    JSON.stringify({
      contentHash,
      title,
      sourceUrl: "https://example.test/source",
      sourceType: "youtube",
    }),
  );
  return contentHash;
}

async function writeHistory(
  vault: string,
  sourceHash: string,
  appliedAt: string,
): Promise<void> {
  const directory = join(vault, "history", crypto.randomUUID());
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "manifest.json"),
    JSON.stringify({ sourceHash, appliedAt }),
  );
}

Deno.test("archived vault sources are hash-checked and retain ingest order", async () => {
  const vault = await Deno.makeTempDir({ prefix: "synthesis-archive-test-" });
  try {
    await Deno.mkdir(join(vault, "sources"));
    const later = await writeSource(vault, "Later source", "Later evidence");
    const earlier = await writeSource(
      vault,
      "Earlier source",
      "Earlier evidence",
    );
    await writeHistory(vault, later, "2026-02-01T00:00:00.000Z");
    await writeHistory(vault, earlier, "2026-01-01T00:00:00.000Z");

    const sources = await loadArchivedVaultSources(vault);
    assert.deepEqual(
      sources.map((source) => source.title),
      ["Earlier source", "Later source"],
    );
    assert.deepEqual(
      sources.map((source) => source.contentHash),
      [earlier, later],
    );

    await Deno.writeTextFile(
      join(vault, "sources", earlier, "source.txt"),
      "Tampered evidence",
    );
    await assert.rejects(
      () => loadArchivedVaultSources(vault),
      /failed its hash check/,
    );
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("recompile layout creates both mutable content directories", async () => {
  const vault = await Deno.makeTempDir({
    prefix: "synthesis-recompile-layout-test-",
  });
  try {
    await ensureRecompileVaultLayout(vault);
    assert.equal((await Deno.stat(join(vault, "notes"))).isDirectory, true);
    assert.equal((await Deno.stat(join(vault, "sources"))).isDirectory, true);
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
