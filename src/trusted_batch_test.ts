import assert from "node:assert/strict";

import {
  trustedBatchConfirmation,
  TrustedBatchInputError,
  validateTrustedBatchRequest,
} from "./trusted_batch.ts";

Deno.test("trusted batches require an exact bounded source snapshot", () => {
  const first = "dQw4w9WgXcQ";
  const second = "https://youtu.be/9bZkp7q19f0";
  assert.deepEqual(
    validateTrustedBatchRequest({
      urls: [first, second],
      reviewMode: "automatic",
      confirm: trustedBatchConfirmation(2),
    }, 10),
    {
      urls: [
        `https://www.youtube.com/watch?v=${first}`,
        "https://www.youtube.com/watch?v=9bZkp7q19f0",
      ],
      reviewMode: "automatic",
    },
  );
});

Deno.test("trusted batches reject weak confirmation and duplicate videos", () => {
  assert.throws(
    () =>
      validateTrustedBatchRequest({
        urls: ["dQw4w9WgXcQ"],
        reviewMode: "automatic",
        confirm: "AUTO APPLY",
      }, 10),
    TrustedBatchInputError,
  );
  assert.throws(
    () =>
      validateTrustedBatchRequest({
        urls: [
          "dQw4w9WgXcQ",
          "https://youtu.be/dQw4w9WgXcQ",
        ],
        reviewMode: "automatic",
        confirm: trustedBatchConfirmation(2),
      }, 10),
    /must be unique/,
  );
  assert.throws(
    () =>
      validateTrustedBatchRequest({
        urls: ["dQw4w9WgXcQ", "9bZkp7q19f0"],
        reviewMode: "automatic",
        confirm: trustedBatchConfirmation(2),
      }, 1),
    /1-1/,
  );
});
