import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import { writeIngestHistory } from "./ingest_history.ts";
import {
  IngestUndoConflictError,
  IngestUndoNotAvailableError,
  undoLastIngest,
} from "./ingest_undo.ts";
import { renderWikiPage } from "./wiki.ts";

Deno.test({
  name: "last-ingest undo restores files and catalog without deleting sources",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-undo-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalVaultDir = config.vaultDir;
    try {
      config.vaultDir = dir;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      const priorHash = "a".repeat(64);
      const undoneHash = "b".repeat(64);
      const priorSourceId = db.addSource(
        priorHash,
        "Prior source",
        null,
        "text",
        `${dir}/sources/${priorHash}/source.txt`,
        "Prior summary",
      );
      const undoneSourceId = db.addSource(
        undoneHash,
        "Undone source",
        null,
        "text",
        `${dir}/sources/${undoneHash}/source.txt`,
        "Undone summary",
      );
      const before = renderWikiPage({
        title: "Existing knowledge",
        type: "concept",
        body: "The prior mechanism is recoverable.",
        tags: ["undo"],
        links: [],
      }, [{ title: "Prior source", contentHash: priorHash }]);
      const after = renderWikiPage({
        title: "Existing knowledge",
        type: "concept",
        body: "The prior mechanism is recoverable. New evidence extends it.",
        tags: ["undo"],
        links: ["New knowledge"],
      }, [{ title: "Prior source", contentHash: priorHash }, {
        title: "Undone source",
        contentHash: undoneHash,
      }]);
      const created = renderWikiPage({
        title: "New knowledge",
        type: "entity",
        body: "This page was introduced by the accepted ingest.",
        tags: ["undo"],
        links: ["Existing knowledge"],
      }, [{ title: "Undone source", contentHash: undoneHash }]);
      const existingPath = `${dir}/notes/existing.md`;
      const createdPath = `${dir}/notes/new.md`;
      await Deno.writeTextFile(existingPath, after);
      await Deno.writeTextFile(createdPath, created);
      const existingId = db.addNote(
        "Existing knowledge",
        existingPath,
        null,
        "text",
      );
      const createdId = db.addNote("New knowledge", createdPath, null, "text");
      db.indexNote(
        existingId,
        "Existing knowledge",
        "New evidence extends it.",
      );
      db.indexNote(
        createdId,
        "New knowledge",
        "Introduced by accepted ingest.",
      );
      db.attachNoteSource(existingId, priorSourceId, "new");
      db.attachNoteSource(existingId, undoneSourceId, "merge");
      db.attachNoteSource(createdId, undoneSourceId, "new");
      db.upsertEmbedding(existingId, [
        1,
        ...Array<number>(config.embed.dimensions - 1).fill(0),
      ]);
      db.upsertEmbedding(createdId, [
        0,
        1,
        ...Array<number>(config.embed.dimensions - 2).fill(0),
      ]);
      db.upsertLink(existingId, createdId, 0.9);
      const proposalId = db.addIngestProposal(
        undoneSourceId,
        '{"version":1,"changes":[]}',
      );
      assert.equal(db.reviewIngestProposal(proposalId, "approved"), true);
      const history = await writeIngestHistory({
        proposalId,
        sourceHash: undoneHash,
        sourceTitle: "Undone source",
        changes: [{
          action: "merge",
          pageTitle: "Existing knowledge",
          filePath: existingPath,
          beforeContent: before,
          afterContent: after,
        }, {
          action: "new",
          pageTitle: "New knowledge",
          filePath: createdPath,
          afterContent: created,
        }],
      });

      await Deno.writeTextFile(existingPath, `${after}\nmanual edit\n`);
      await assert.rejects(
        undoLastIngest(db),
        IngestUndoConflictError,
      );
      assert.ok(db.getNote(createdId));
      assert.equal(
        await Deno.readTextFile(existingPath),
        `${after}\nmanual edit\n`,
      );

      await Deno.writeTextFile(existingPath, after);
      const result = await undoLastIngest(db);

      assert.deepEqual(result, {
        historyId: history.manifest.historyId,
        sourceTitle: "Undone source",
        restoredCount: 1,
        removedCount: 1,
        indexUpdated: true,
        reset: [
          "affected_embeddings",
          "affected_semantic_links",
          "discoveries",
        ],
      });
      assert.equal(await Deno.readTextFile(existingPath), before);
      await assert.rejects(Deno.stat(createdPath), Deno.errors.NotFound);
      assert.equal(
        await Deno.readTextFile(`${history.directory}/after/001.md`),
        created,
      );
      assert.equal(
        JSON.parse(await Deno.readTextFile(`${history.directory}/undo.json`))
          .historyId,
        history.manifest.historyId,
      );
      assert.equal(db.getNote(createdId), undefined);
      assert.equal(db.getNote(existingId)?.title, "Existing knowledge");
      assert.deepEqual(
        db.searchKeyword("recoverable").map((item) => item.id),
        [existingId],
      );
      assert.deepEqual(
        db.getSourceProvenanceForNote(existingId).map((source) => source.id),
        [priorSourceId],
      );
      assert.ok(db.getSourceByHash(undoneHash));
      assert.deepEqual(db.getIngestProposals(), []);
      assert.equal(db.getEmbedding(existingId), null);
      assert.deepEqual(db.getLinks(), []);
      assert.match(
        await Deno.readTextFile(`${dir}/notes/index.md`),
        /Existing knowledge/,
      );
      assert.doesNotMatch(
        await Deno.readTextFile(`${dir}/notes/index.md`),
        /New knowledge/,
      );
      await assert.rejects(
        undoLastIngest(db),
        IngestUndoNotAvailableError,
      );
    } finally {
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
