import assert from "node:assert/strict";

import {
  ManualQueueInputError,
  validateManualQueueRequest,
} from "./manual_queue.ts";

Deno.test("manual source queues normalise an exact bounded video list", () => {
  assert.deepEqual(
    validateManualQueueRequest({
      urls: ["dQw4w9WgXcQ", "https://youtu.be/9bZkp7q19f0"],
      reviewMode: "manual",
    }, 2),
    {
      urls: [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=9bZkp7q19f0",
      ],
      reviewMode: "manual",
    },
  );
});

Deno.test("manual source queues reject ambiguous or duplicate inputs", () => {
  for (
    const value of [
      null,
      { urls: ["dQw4w9WgXcQ"], reviewMode: "automatic" },
      { urls: [], reviewMode: "manual" },
      {
        urls: ["dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"],
        reviewMode: "manual",
      },
      { urls: ["not a video"], reviewMode: "manual" },
      {
        urls: ["dQw4w9WgXcQ", "9bZkp7q19f0"],
        reviewMode: "manual",
      },
    ]
  ) {
    assert.throws(
      () => validateManualQueueRequest(value, 1),
      ManualQueueInputError,
    );
  }
});
