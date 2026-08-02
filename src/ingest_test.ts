import assert from "node:assert/strict";

import { ingestText, parseVtt, validateYouTubeUrl } from "./ingest.ts";

Deno.test("validateYouTubeUrl accepts canonical HTTPS YouTube hosts", () => {
  const accepted = [
    "https://youtube.com/watch?v=abc123",
    "https://www.youtube.com/watch?v=abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://music.youtube.com/watch?v=abc123",
    "https://youtu.be/abc123",
  ];

  for (const value of accepted) {
    assert.equal(validateYouTubeUrl(value), new URL(value).href);
  }
});

Deno.test("validateYouTubeUrl rejects unsafe or non-YouTube URLs", () => {
  const rejected = [
    "http://youtube.com/watch?v=abc123",
    "https://youtube.com.evil.example/watch?v=abc123",
    "https://notyoutube.com/watch?v=abc123",
    "https://user@youtube.com/watch?v=abc123",
    "https://user:password@youtube.com/watch?v=abc123",
    "https://youtube.com:8443/watch?v=abc123",
    "https://vimeo.com/abc123",
  ];

  for (const value of rejected) {
    assert.throws(() => validateYouTubeUrl(value), /YouTube URL|HTTPS YouTube/);
  }
});

Deno.test("parseVtt removes metadata, timestamps, tags, and adjacent duplicates", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:01.000 align:start position:0%
<c>Hello</c> world

00:00:01.000 --> 00:00:02.000
<c>Hello</c> world

00:00:02.000 --> 00:00:03.000
Second <b>idea</b>

00:00:03.000 --> 00:00:04.000
Hello world
`;

  assert.equal(parseVtt(vtt), "Hello world Second idea Hello world");
});

Deno.test("ingestText preserves its title and text", () => {
  assert.deepEqual(ingestText("A source", "Some source material."), {
    transcript: "Some source material.",
    sourceUrl: "",
    title: "A source",
  });
});
