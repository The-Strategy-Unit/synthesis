import assert from "node:assert/strict";

import {
  classifyIngestSource,
  parseTrustedVideoBatch,
  trustedBatchConfirmation,
} from "./ingest_source.js";

Deno.test("ingest source classification is explicit and playlist-safe", () => {
  const videoId = "dQw4w9WgXcQ";
  const playlistId = "PL1234567890";

  assert.deepEqual(classifyIngestSource("Source text", "auto"), {
    kind: "text",
    value: "Source text",
  });
  assert.deepEqual(classifyIngestSource(videoId, "auto"), {
    kind: "video",
    value: `https://www.youtube.com/watch?v=${videoId}`,
  });
  assert.deepEqual(classifyIngestSource(playlistId, "auto"), {
    kind: "playlist",
    value: `https://www.youtube.com/playlist?list=${playlistId}`,
  });
  assert.equal(
    classifyIngestSource(
      `https://www.youtube.com/playlist?list=${playlistId}`,
      "auto",
    ).kind,
    "playlist",
  );

  for (
    const value of [
      `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,
      `https://youtu.be/${videoId}?list=${playlistId}`,
      `https://www.youtube.com/shorts/${videoId}?list=${playlistId}`,
    ]
  ) {
    assert.equal(
      classifyIngestSource(value, "auto").kind,
      "video",
      `${value} must not expand into a playlist automatically`,
    );
  }

  assert.deepEqual(
    classifyIngestSource(`https://example.test/?list=${playlistId}`, "text"),
    { kind: "text", value: `https://example.test/?list=${playlistId}` },
  );
  assert.deepEqual(
    classifyIngestSource(
      `https://www.youtube.com/playlist?list=${playlistId}`,
      "video",
    ),
    {
      kind: "video",
      value: `https://www.youtube.com/playlist?list=${playlistId}`,
    },
  );
  assert.deepEqual(
    classifyIngestSource(
      `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,
      "playlist",
    ),
    {
      kind: "playlist",
      value: `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,
    },
  );

  assert.throws(
    () => classifyIngestSource("Source", "unknown"),
    /Invalid ingest source type/,
  );
});

Deno.test("trusted video batches preserve the exact non-empty line list", () => {
  assert.deepEqual(
    parseTrustedVideoBatch(" dQw4w9WgXcQ\n\nhttps://youtu.be/9bZkp7q19f0 \n"),
    ["dQw4w9WgXcQ", "https://youtu.be/9bZkp7q19f0"],
  );
  assert.equal(
    trustedBatchConfirmation(2),
    "AUTO APPLY 2 TRUSTED SOURCES",
  );
  assert.throws(() => parseTrustedVideoBatch("\n \n"), /at least one/);
  assert.throws(() => trustedBatchConfirmation(0), RangeError);
});
