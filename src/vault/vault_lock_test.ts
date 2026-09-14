import assert from "node:assert/strict";

import {
  acquireVaultProcessLock,
  VaultAlreadyOpenError,
} from "./vault_lock.ts";

Deno.test({
  name: "a writable vault has one process owner and releases after close",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir({
      prefix: "synthesis-vault-lock-",
    });
    try {
      const first = acquireVaultProcessLock(directory);
      assert.throws(
        () => acquireVaultProcessLock(directory),
        VaultAlreadyOpenError,
      );
      first.release();
      const next = acquireVaultProcessLock(directory);
      next.release();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "vault ownership rejects a substituted lock target",
  permissions: "inherit",
  fn: async () => {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${directory}/.synthesis-lock.db`);
      assert.throws(
        () => acquireVaultProcessLock(directory),
        /small ordinary file/,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
