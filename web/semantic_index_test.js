import assert from "node:assert/strict";

import {
  buildCompleteSemanticIndex,
  SEMANTIC_REBUILD_BATCH_SIZE,
} from "./semantic_index.js";

Deno.test("semantic index runner processes bounded batches until complete", async () => {
  const statuses = [{
    processed: 20,
    embedded: 20,
    total: 23,
    remaining: 3,
    complete: false,
  }, {
    processed: 3,
    embedded: 23,
    total: 23,
    remaining: 0,
    complete: true,
  }];
  const limits = [];
  const progress = [];

  const result = await buildCompleteSemanticIndex((limit) => {
    limits.push(limit);
    return Promise.resolve(statuses.shift());
  }, {
    onProgress: (status) => progress.push(status.embedded),
  });

  assert.deepEqual(limits, [
    SEMANTIC_REBUILD_BATCH_SIZE,
    SEMANTIC_REBUILD_BATCH_SIZE,
  ]);
  assert.deepEqual(progress, [20, 23]);
  assert.equal(result.status.complete, true);
  assert.equal(result.stopped, false);
});

Deno.test("semantic index runner stops safely between batches", async () => {
  let stopRequested = false;
  let calls = 0;
  const result = await buildCompleteSemanticIndex(() => {
    calls++;
    return Promise.resolve({
      processed: 20,
      embedded: 20,
      total: 40,
      remaining: 20,
      complete: false,
    });
  }, {
    shouldStop: () => stopRequested,
    onProgress: () => {
      stopRequested = true;
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status.embedded, 20);
  assert.equal(result.stopped, true);
});

Deno.test("semantic index runner rejects stalled or invalid progress", async () => {
  await assert.rejects(
    () =>
      buildCompleteSemanticIndex(() =>
        Promise.resolve({
          processed: 0,
          embedded: 20,
          total: 40,
          remaining: 20,
          complete: false,
        })
      ),
    /made no progress/,
  );
  await assert.rejects(
    () =>
      buildCompleteSemanticIndex(() =>
        Promise.resolve({
          processed: 1,
          embedded: 20,
          total: 40,
          remaining: 19,
          complete: false,
        })
      ),
    /invalid progress/,
  );
});
