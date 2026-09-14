import assert from "node:assert/strict";

import {
  applyVaultOperation,
  completeVaultOperation,
  prepareVaultOperation,
  recoverPendingVaultOperations,
  rollbackVaultOperation,
  VaultOperationConflictError,
} from "./vault_operation.ts";

Deno.test({
  name: "vault operations apply and roll back an exact file set",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${directory}/notes`);
      const notePath = `${directory}/notes/topic.md`;
      await Deno.writeTextFile(notePath, "before");
      const operation = await prepareVaultOperation(directory, [{
        filePath: notePath,
        beforeContent: "before",
        afterContent: "after",
      }]);

      await applyVaultOperation(operation);
      assert.equal(await Deno.readTextFile(notePath), "after");
      await rollbackVaultOperation(operation);
      assert.equal(await Deno.readTextFile(notePath), "before");
      await completeVaultOperation(operation);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "startup recovery rolls an interrupted operation forward once",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${directory}/notes`);
      const notePath = `${directory}/notes/recovered.md`;
      const operation = await prepareVaultOperation(directory, [{
        filePath: notePath,
        beforeContent: null,
        afterContent: "recovered",
      }]);
      await applyVaultOperation(operation);

      const recovered = await recoverPendingVaultOperations(directory);
      assert.equal(recovered.length, 1);
      assert.equal(await Deno.readTextFile(notePath), "recovered");
      await assert.rejects(
        prepareVaultOperation(directory, [{
          filePath: `${directory}/notes/blocked.md`,
          beforeContent: null,
          afterContent: "blocked",
        }]),
        /pending recovery operation/,
      );
      await completeVaultOperation(recovered[0]);
      assert.equal((await recoverPendingVaultOperations(directory)).length, 0);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "startup recovery refuses to overwrite a conflicting external edit",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${directory}/notes`);
      const safePath = `${directory}/notes/safe.md`;
      const notePath = `${directory}/notes/conflict.md`;
      await Deno.writeTextFile(safePath, "before");
      await Deno.writeTextFile(notePath, "before");
      await prepareVaultOperation(directory, [
        {
          filePath: safePath,
          beforeContent: "before",
          afterContent: "approved",
        },
        {
          filePath: notePath,
          beforeContent: "before",
          afterContent: "approved",
        },
      ]);
      await Deno.writeTextFile(notePath, "external edit");

      await assert.rejects(
        recoverPendingVaultOperations(directory),
        VaultOperationConflictError,
      );
      assert.equal(await Deno.readTextFile(safePath), "before");
      assert.equal(await Deno.readTextFile(notePath), "external edit");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
