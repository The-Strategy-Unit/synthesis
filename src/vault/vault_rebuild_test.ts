import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import { rebuildVaultCatalogue } from "./vault_rebuild.ts";
import { renderWikiPage } from "../wiki/wiki.ts";

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function writeSource(
  dir: string,
  input: {
    title: string;
    transcript: string;
    sourceType: "text" | "markdown";
    original?: Uint8Array;
  },
): Promise<string> {
  const hash = await sha256(input.original ?? encoder.encode(input.transcript));
  const sourceDir = `${dir}/sources/${hash}`;
  await Deno.mkdir(sourceDir, { recursive: true });
  await Deno.writeTextFile(`${sourceDir}/source.txt`, input.transcript);
  await Deno.writeTextFile(
    `${sourceDir}/summary.md`,
    `${input.title} summary.\n`,
  );
  if (input.original) {
    await Deno.writeFile(`${sourceDir}/original.md`, input.original);
  }
  await Deno.writeTextFile(
    `${sourceDir}/meta.json`,
    JSON.stringify(
      {
        contentHash: hash,
        title: input.title,
        sourceUrl: "",
        sourceType: input.sourceType,
        ...(input.original
          ? { originalFileName: "evidence.md", mediaType: "text/markdown" }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  return hash;
}

Deno.test({
  name: "vault files rebuild the complete provider-independent catalogue",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-rebuild-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalVaultDir = config.vaultDir;
    const originalFetch = globalThis.fetch;
    try {
      config.vaultDir = dir;
      const textHash = await writeSource(dir, {
        title: "Pasted evidence",
        transcript: "Evidence retained exactly.\n",
        sourceType: "text",
      });
      const originalMarkdown = encoder.encode(
        "# Local original\n\nEvidence.\n",
      );
      const localHash = await writeSource(dir, {
        title: "Local evidence",
        transcript: "Normalised local evidence.\n",
        sourceType: "markdown",
        original: originalMarkdown,
      });
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/notes/alpha.md`,
        renderWikiPage({
          title: "Alpha mechanism",
          type: "concept",
          body: "Alpha evidence is retained and searchable.",
          tags: ["rebuild"],
          links: ["Beta observation"],
        }, [{ title: "Pasted evidence", contentHash: textHash }]),
      );
      await Deno.writeTextFile(
        `${dir}/notes/beta.md`,
        renderWikiPage({
          title: "Beta observation",
          type: "entity",
          body: "Beta joins evidence from local and pasted sources.",
          tags: ["rebuild"],
          links: ["Alpha mechanism"],
        }, [{ title: "Local evidence", contentHash: localHash }, {
          title: "Pasted evidence",
          contentHash: textHash,
        }]),
      );
      await Deno.writeTextFile(`${dir}/notes/index.md`, "stale index\n");
      await Deno.writeTextFile(`${dir}/notes/log.md`, "preserved log\n");

      const staleSourceId = db.sources.addSource(
        "stale-source",
        "Stale source",
        null,
        "text",
        `${dir}/stale.txt`,
        "Stale summary",
      );
      const staleNoteId = db.notes.addNote(
        "Stale note",
        `${dir}/stale.md`,
        null,
        "text",
      );
      db.notes.indexNote(staleNoteId, "Stale note", "Stale searchable body.");
      db.sources.attachNoteSource(staleNoteId, staleSourceId, "new");
      db.proposals.addIngestProposal(
        staleSourceId,
        '{"version":1,"changes":[]}',
      );
      globalThis.fetch = () => {
        throw new Error("vault rebuild must not call a provider");
      };

      const result = await rebuildVaultCatalogue(db);

      assert.deepEqual(result, {
        sourceCount: 2,
        noteCount: 2,
        provenanceCount: 3,
        reset: [
          "embeddings",
          "semantic_links",
          "proposals",
          "discovery_candidates",
          "discoveries",
        ],
      });
      assert.equal(db.sources.getSourceByHash("stale-source"), undefined);
      assert.equal(db.notes.getNoteByExactTitle("Stale note"), undefined);
      const alpha = db.notes.getNoteByExactTitle("Alpha mechanism");
      const beta = db.notes.getNoteByExactTitle("Beta observation");
      assert.ok(alpha);
      assert.ok(beta);
      assert.deepEqual(
        db.search.searchKeyword("searchable").map((item) => item.id),
        [alpha.id],
      );
      const localSource = db.sources.getSourceByHash(localHash);
      assert.ok(localSource);
      assert.equal(db.sources.getNotesForSource(localSource.id)[0].id, beta.id);
      assert.equal(
        db.sources.getNotesForSource(localSource.id)[0].action,
        "reference",
      );
      assert.deepEqual(db.proposals.getIngestProposals(), []);
      assert.deepEqual(db.discoveries.getDiscoveries(), []);
      assert.deepEqual(db.search.getLinks(), []);
      assert.match(
        await Deno.readTextFile(`${dir}/notes/index.md`),
        /Alpha mechanism/,
      );
      assert.match(
        await Deno.readTextFile(`${dir}/notes/index.md`),
        /Beta observation/,
      );
      assert.equal(
        await Deno.readTextFile(`${dir}/notes/log.md`),
        "preserved log\n",
      );

      await Deno.writeTextFile(
        `${dir}/sources/${localHash}/original.md`,
        "tampered original\n",
      );
      await assert.rejects(
        rebuildVaultCatalogue(db),
        /does not match its SHA-256/,
      );
      assert.equal(db.notes.getAllNotes().length, 2);
      assert.equal(
        db.notes.getNoteByExactTitle("Alpha mechanism")?.id,
        alpha.id,
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
