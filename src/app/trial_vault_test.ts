import assert from "node:assert/strict";
import { join } from "node:path";

import { findSourceReferenceHashes, parseWikiPage } from "../wiki/wiki.ts";
import { seedTrialVault } from "./trial_vault.ts";

Deno.test("trial vault is portable, cited, and refuses existing data", async () => {
  const root = await Deno.makeTempDir({ prefix: "synthesis-trial-test-" });
  const vault = join(root, "vault");
  try {
    await seedTrialVault(vault);
    const sourceDirectories = [];
    for await (const entry of Deno.readDir(join(vault, "sources"))) {
      assert.equal(entry.isDirectory, true);
      sourceDirectories.push(entry.name);
    }
    assert.equal(sourceDirectories.length, 4);

    const noteFiles = [];
    for await (const entry of Deno.readDir(join(vault, "notes"))) {
      noteFiles.push(entry.name);
      const markdown = await Deno.readTextFile(
        join(vault, "notes", entry.name),
      );
      const page = parseWikiPage(markdown);
      assert.ok(page.links.length >= 2);
      assert.ok(findSourceReferenceHashes(markdown).length >= 1);
    }
    assert.equal(noteFiles.length, 7);
    const walkthrough = await Deno.readTextFile(
      join(vault, "notes", "how-the-evidence-conflict-evolved.md"),
    );
    assert.match(walkthrough, /BPROAD/);
    assert.match(walkthrough, /contradiction/);
    assert.match(walkthrough, /not a clinical recommendation/);
    await assert.rejects(() => seedTrialVault(vault), /must be empty/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
