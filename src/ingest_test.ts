import assert from "node:assert/strict";

import { defaultYtDlpExecutable } from "./config.ts";
import { ingestText, parseVtt } from "./ingest.ts";
import {
  normalizeYouTubePlaylistInput,
  normalizeYouTubeVideoInput,
  validateYouTubeUrl,
} from "./youtube_url.ts";

Deno.test("yt-dlp uses the platform executable name", () => {
  const missing = () => false;
  assert.equal(
    defaultYtDlpExecutable(
      "windows",
      String.raw`C:\demo\synthesis.exe`,
      missing,
    ),
    "yt-dlp.exe",
  );
  assert.equal(
    defaultYtDlpExecutable("linux", "/demo/synthesis", missing),
    "yt-dlp",
  );
  assert.equal(
    defaultYtDlpExecutable("darwin", "/demo/synthesis", missing),
    "yt-dlp",
  );
  assert.equal(
    defaultYtDlpExecutable(
      "windows",
      String.raw`C:\demo\synthesis.exe`,
      (path) => path === String.raw`C:\demo\yt-dlp.exe`,
    ),
    String.raw`C:\demo\yt-dlp.exe`,
  );
});

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

Deno.test("YouTube video IDs and URLs normalize to canonical watch URLs", () => {
  const videoId = "dQw4w9WgXcQ";
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const accepted = [
    videoId,
    `https://youtube.com/watch?v=${videoId}&list=PL1234567890`,
    `https://youtu.be/${videoId}?feature=shared`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
  ];

  for (const value of accepted) {
    assert.equal(normalizeYouTubeVideoInput(value), canonical);
  }
  for (
    const value of [
      "not-a-video-id",
      "https://www.youtube.com/",
      "https://www.youtube.com/playlist?list=PL1234567890",
    ]
  ) {
    assert.throws(
      () => normalizeYouTubeVideoInput(value),
      /YouTube|video ID/,
    );
  }
});

Deno.test("YouTube playlist IDs and URLs normalize canonically", () => {
  const playlistId = "PL1234567890";
  const canonical = `https://www.youtube.com/playlist?list=${playlistId}`;
  for (
    const value of [
      playlistId,
      `https://www.youtube.com/playlist?list=${playlistId}`,
      `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${playlistId}`,
    ]
  ) {
    assert.equal(normalizeYouTubePlaylistInput(value), canonical);
  }
  for (
    const value of [
      "",
      "playlist with spaces",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]
  ) {
    assert.throws(
      () => normalizeYouTubePlaylistInput(value),
      /YouTube|playlist ID/,
    );
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
    sourceType: "text",
  });
});
