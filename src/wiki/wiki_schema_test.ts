import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import {
  DEFAULT_WIKI_SCHEMA,
  ensureWikiSchema,
  loadWikiSchema,
  promptWithWikiSchema,
  saveWikiSchema,
  validateWikiSchema,
  wikiSchemaPath,
} from "./wiki_schema.ts";

Deno.test({
  name: "wiki schema is bounded, created once, and preserves user edits",
  permissions: "inherit",
  fn: async () => {
    const originalVaultDir = config.vaultDir;
    const vault = await Deno.makeTempDir({ prefix: "synthesis-schema-test-" });
    try {
      config.vaultDir = vault;
      await assert.rejects(
        loadWikiSchema(),
        /Wiki schema is missing/,
      );

      const created = await ensureWikiSchema();
      assert.equal(created, validateWikiSchema(DEFAULT_WIKI_SCHEMA));
      assert.equal(await Deno.readTextFile(wikiSchemaPath()), created);
      assert.match(created, /## Product boundary/);
      assert.match(created, /does not make clinical/);

      const custom = validateWikiSchema(
        `# Custom research schema\n\n## Purpose\n\n${
          "Preserve domain-specific evidence and uncertainty. ".repeat(8)
        }`,
      );
      await Deno.writeTextFile(wikiSchemaPath(), custom);
      assert.equal(await ensureWikiSchema(), custom);
      assert.equal(await loadWikiSchema(), custom);

      const updated = validateWikiSchema(
        `# Updated research schema\n\n## Purpose\n\n${
          "Connect evidence without making consequential decisions. ".repeat(7)
        }`,
      );
      assert.equal(await saveWikiSchema(updated), updated);
      assert.equal(await loadWikiSchema(), updated);
      await assert.rejects(
        saveWikiSchema("# Invalid\n"),
        /must contain at least 200 characters/,
      );
      assert.equal(
        await loadWikiSchema(),
        updated,
        "an invalid save must preserve the prior schema",
      );

      await Deno.writeTextFile(wikiSchemaPath(), "# Too short\n");
      await assert.rejects(
        ensureWikiSchema(),
        /must contain at least 200 characters/,
      );
    } finally {
      config.vaultDir = originalVaultDir;
      await Deno.remove(vault, { recursive: true });
    }
  },
});

Deno.test("wiki schema rejects unsafe or unstructured text", () => {
  assert.throws(
    () => validateWikiSchema(`${"x".repeat(220)}\u0000`),
    /control characters/,
  );
  assert.throws(
    () => validateWikiSchema(`No heading\n\n${"x".repeat(220)}`),
    /level-one Markdown heading/,
  );
  assert.throws(
    () => validateWikiSchema(`# Huge\n\n${"x".repeat(16_001)}`),
    /must not exceed 16000 characters/,
  );
});

Deno.test("model prompts always include the mandatory editorial policy", () => {
  const customSchema = validateWikiSchema(
    `# Custom research schema\n\n## Purpose\n\n${
      "Preserve domain-specific evidence and uncertainty. ".repeat(8)
    }`,
  );
  const prompt = promptWithWikiSchema(
    "Summarise the supplied evidence.",
    customSchema,
  );

  assert.match(prompt, /British English/);
  assert.match(prompt, /potentially mistranscribed/);
  assert.match(prompt, /Do not fill gaps from background knowledge/);
  assert.match(prompt, /plausible spelling or transcription variants/);
  assert.match(prompt, /# Custom research schema/);
});
