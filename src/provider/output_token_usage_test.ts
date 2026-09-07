import assert from "node:assert/strict";

import {
  type OutputTokenUsageFileStore,
  OutputTokenUsageStore,
} from "./output_token_usage.ts";

function memoryFiles(initial?: string) {
  let content = initial;
  const files: OutputTokenUsageFileStore = {
    read: () =>
      content === undefined
        ? Promise.reject(new Deno.errors.NotFound())
        : Promise.resolve(content),
    write: (_path, value) => {
      content = value;
      return Promise.resolve();
    },
  };
  return { files, content: () => content };
}

Deno.test("remote output usage persists concurrent monthly totals", async () => {
  const memory = memoryFiles();
  const store = new OutputTokenUsageStore("usage.json", memory.files);
  const now = new Date("2026-09-07T12:00:00Z");

  await Promise.all([
    store.record(600_000, now),
    store.record(400_001, now),
  ]);

  assert.deepEqual(await store.summary(now), {
    period: "2026-09",
    outputTokens: 1_000_001,
    warningThreshold: 1_000_000,
    hasWarning: true,
  });
  assert.deepEqual(
    await new OutputTokenUsageStore("usage.json", memory.files).summary(now),
    {
      period: "2026-09",
      outputTokens: 1_000_001,
      warningThreshold: 1_000_000,
      hasWarning: true,
    },
  );
  assert.doesNotMatch(memory.content() ?? "", /api|key|content/i);
});

Deno.test("remote output usage resets at a calendar-month boundary", async () => {
  const memory = memoryFiles(JSON.stringify({
    version: 1,
    period: "2026-09",
    outputTokens: 900_000,
  }));
  const store = new OutputTokenUsageStore("usage.json", memory.files);

  assert.deepEqual(await store.summary(new Date("2026-10-01T00:00:00Z")), {
    period: "2026-10",
    outputTokens: 0,
    warningThreshold: 1_000_000,
    hasWarning: false,
  });
});

Deno.test("remote output usage rejects malformed stored or reported totals", async () => {
  const malformed = new OutputTokenUsageStore(
    "usage.json",
    memoryFiles('{"version":1,"period":"later","outputTokens":4}').files,
  );
  await assert.rejects(() => malformed.summary(), /usage data is invalid/i);

  const store = new OutputTokenUsageStore("usage.json", memoryFiles().files);
  await assert.rejects(() => store.record(-1), /token usage is invalid/i);
});
