import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import {
  historyDir,
  readIngestHistoryManifest,
  removeWrittenIngestHistory,
  validateIngestHistoryManifest,
  writeIngestHistory,
} from "./ingest_history.ts";

Deno.test({
  name: "ingest history captures reversible revisions inside the vault",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-history-test-" });
    const originalVaultDir = config.vaultDir;
    try {
      config.vaultDir = dir;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      const before = "# Existing\n\nBefore.\n";
      const after = "# Existing\n\nAfter.\n";
      const created = "# New\n\nCreated.\n";
      const written = await writeIngestHistory({
        proposalId: 7,
        sourceHash: "a".repeat(64),
        sourceTitle: "Reviewed source",
        changes: [{
          action: "merge",
          pageTitle: "Existing",
          filePath: `${dir}/notes/existing.md`,
          beforeContent: before,
          afterContent: after,
        }, {
          action: "new",
          pageTitle: "New",
          filePath: `${dir}/notes/new.md`,
          afterContent: created,
        }],
      });

      assert.equal(written.manifest.proposalId, 7);
      assert.equal(written.manifest.reviewMode, "manual");
      assert.equal(written.manifest.batchId, undefined);
      assert.equal(written.manifest.changes[0].notePath, "notes/existing.md");
      assert.equal(written.manifest.changes[0].beforeRevision, "before/000.md");
      assert.equal(written.manifest.changes[1].beforeRevision, undefined);
      assert.equal(
        await Deno.readTextFile(`${written.directory}/before/000.md`),
        before,
      );
      assert.deepEqual(
        await readIngestHistoryManifest(written.directory),
        written.manifest,
      );
      assert.match(
        written.manifest.changes[0].beforeHash ?? "",
        /^[a-f0-9]{64}$/,
      );
      assert.match(written.manifest.changes[0].afterHash, /^[a-f0-9]{64}$/);
      assert.notEqual(
        written.manifest.changes[0].beforeHash,
        written.manifest.changes[0].afterHash,
      );

      await assert.rejects(
        writeIngestHistory({
          proposalId: 8,
          sourceHash: "b".repeat(64),
          sourceTitle: "Unsafe source",
          changes: [{
            action: "new",
            pageTitle: "Outside",
            filePath: `${dir}/outside.md`,
            afterContent: "Outside",
          }],
        }),
        /inside vault notes/,
      );
      assert.equal(
        [...Deno.readDirSync(historyDir())].length,
        1,
        "failed history writes must clean up their generated directory",
      );

      assert.throws(() =>
        validateIngestHistoryManifest({
          ...written.manifest,
          sourceHash: "invalid",
        })
      );

      const legacy = { ...written.manifest } as Record<string, unknown>;
      delete legacy.reviewMode;
      assert.equal(validateIngestHistoryManifest(legacy).reviewMode, "manual");

      const batchId = crypto.randomUUID();
      const automatic = validateIngestHistoryManifest({
        ...written.manifest,
        reviewMode: "automatic",
        batchId,
      });
      assert.equal(automatic.reviewMode, "automatic");
      assert.equal(automatic.batchId, batchId);
      assert.throws(
        () =>
          validateIngestHistoryManifest({
            ...written.manifest,
            reviewMode: "automatic",
          }),
        /batchId/,
      );

      await removeWrittenIngestHistory(written);
      await assert.rejects(
        Deno.stat(written.directory),
        Deno.errors.NotFound,
      );
    } finally {
      config.vaultDir = originalVaultDir;
      await Deno.remove(dir, { recursive: true });
    }
  },
});
