import assert from "node:assert/strict";

import {
  parseRecompileArguments,
  recompileLogAction,
  sourceHashesInWikiLog,
} from "./recompile_vault.ts";

Deno.test("recompile arguments require explicit models and confirmation", () => {
  const parsed = parseRecompileArguments([
    "--source",
    "old-vault",
    "--destination",
    "new-vault",
    "--extract-model",
    "qwen3.5:27b",
    "--editor-model",
    "gpt-oss:120b",
    "--confirm",
    "RECOMPILE 66 SOURCES",
    "--resume",
  ]);

  assert.equal(parsed.extractModel, "qwen3.5:27b");
  assert.equal(parsed.editorModel, "gpt-oss:120b");
  assert.equal(parsed.embeddingModel, "nomic-embed-text-v2-moe:latest");
  assert.equal(parsed.confirmation, "RECOMPILE 66 SOURCES");
  assert.equal(parsed.resume, true);
  assert.notEqual(parsed.source, parsed.destination);
});

Deno.test("recompile arguments reject ambiguous input", () => {
  assert.throws(
    () =>
      parseRecompileArguments([
        "--source",
        "old-vault",
        "--destination",
        "new-vault",
        "--extract-model",
        "model",
        "--editor-model",
        "model",
      ]),
    /--confirm is required/,
  );
  assert.throws(
    () => parseRecompileArguments(["--unknown", "value"]),
    /Unknown argument/,
  );
});

Deno.test("recompile catalogue repair recognises logged source actions", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  assert.deepEqual(
    [...sourceHashesInWikiLog(
      `# Log\n- Source SHA-256: \`${first}\`\n- ignored\n- Source SHA-256: \`${second}\`\n`,
    )],
    [first, second],
  );
  assert.equal(recompileLogAction("new"), "create");
  assert.equal(recompileLogAction("merge"), "update");
  assert.equal(recompileLogAction("contradict"), "contradict");
  assert.throws(() => recompileLogAction("query"), /invalid note action/);
});
