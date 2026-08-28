import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import { writeIngestHistory } from "./ingest_history.ts";
import {
  IngestUndoConflictError,
  IngestUndoNotAvailableError,
  undoLastIngest,
} from "./ingest_undo.ts";
import { renderWikiPage } from "../wiki/wiki.ts";

Deno.test({
  name:
    "last-ingest undo restores files and catalogue without deleting sources",
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
      const priorSourceId = db.sources.addSource(
        priorHash,
        "Prior source",
        null,
        "text",
        `${dir}/sources/${priorHash}/source.txt`,
        "Prior summary",
      );
      const undoneSourceId = db.sources.addSource(
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
      const existingId = db.notes.addNote(
        "Existing knowledge",
        existingPath,
        null,
        "text",
      );
      const createdId = db.notes.addNote(
        "New knowledge",
        createdPath,
        null,
        "text",
      );
      db.notes.indexNote(
        existingId,
        "Existing knowledge",
        "New evidence extends it.",
      );
      db.notes.indexNote(
        createdId,
        "New knowledge",
        "Introduced by accepted ingest.",
      );
      db.sources.attachNoteSource(existingId, priorSourceId, "new");
      db.sources.attachNoteSource(existingId, undoneSourceId, "merge");
      db.sources.attachNoteSource(createdId, undoneSourceId, "new");
      db.search.upsertEmbedding(existingId, [
        1,
        ...Array<number>(config.embed.dimensions - 1).fill(0),
      ]);
      db.search.upsertEmbedding(createdId, [
        0,
        1,
        ...Array<number>(config.embed.dimensions - 2).fill(0),
      ]);
      db.search.upsertLink(existingId, createdId, 0.9);
      const proposalId = db.proposals.addIngestProposal(
        undoneSourceId,
        '{"version":1,"changes":[]}',
      );
      assert.equal(
        db.proposals.reviewIngestProposal(proposalId, "approved"),
        true,
      );
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
      assert.ok(db.notes.getNote(createdId));
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
          "discovery_candidates",
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
      assert.equal(db.notes.getNote(createdId), undefined);
      assert.equal(db.notes.getNote(existingId)?.title, "Existing knowledge");
      assert.deepEqual(
        db.search.searchKeyword("recoverable").map((item) => item.id),
        [existingId],
      );
      assert.deepEqual(
        db.sources.getSourceProvenanceForNote(existingId).map((source) =>
          source.id
        ),
        [priorSourceId],
      );
      assert.ok(db.sources.getSourceByHash(undoneHash));
      assert.deepEqual(db.proposals.getIngestProposals(), []);
      assert.equal(db.search.getEmbedding(existingId), null);
      assert.deepEqual(db.search.getLinks(), []);
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
