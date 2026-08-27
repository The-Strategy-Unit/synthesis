import assert from "node:assert/strict";

import { config } from "./config.ts";
import {
  ensureVaultManifest,
  validateVaultManifest,
  vaultManifestPath,
} from "./vault_manifest.ts";

Deno.test({
  name: "vault manifests are stable, local, and strictly validated",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-manifest-test-" });
    const originalVaultDir = config.vaultDir;
    try {
      config.vaultDir = dir;
      const first = await ensureVaultManifest();
      const second = await ensureVaultManifest();
      assert.deepEqual(second, first);
      assert.equal(vaultManifestPath(), `${dir}/vault.json`);
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(vaultManifestPath())),
        first,
      );
      assert.equal(first.formatVersion, 1);
      assert.match(first.vaultId, /^[0-9a-f-]{36}$/i);

      for (
        const invalid of [
          null,
          { ...first, formatVersion: 2 },
          { ...first, vaultId: "not-a-uuid" },
          { ...first, createdAt: "yesterday" },
        ]
      ) {
        assert.throws(() => validateVaultManifest(invalid));
      }

      await Deno.writeTextFile(vaultManifestPath(), "{invalid");
      await assert.rejects(ensureVaultManifest(), /invalid JSON/);
    } finally {
      config.vaultDir = originalVaultDir;
      await Deno.remove(dir, { recursive: true });
    }
  },
});
