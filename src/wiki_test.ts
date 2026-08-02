import assert from "node:assert/strict";

import {
  parseWikiPage,
  renderWikiIndex,
  renderWikiLink,
  renderWikiLogEntry,
  renderWikiPage,
  validateWikiPage,
  type WikiPage,
} from "./wiki.ts";

const page: WikiPage = {
  title: "Evidence Map",
  type: "synthesis",
  body: "The available evidence supports the main claim.",
  tags: ["research"],
  links: ["Claim One"],
};

Deno.test("wiki pages normalize tags and links", () => {
  assert.deepEqual(
    validateWikiPage({
      title: "Evidence Map",
      type: "concept",
      body: "A concise explanation.",
      tags: ["AI", "ai", "evidence"],
      links: ["Evidence Map", "Claim One", "claim one", "Claim Two"],
    }),
    {
      title: "Evidence Map",
      type: "concept",
      body: "A concise explanation.",
      tags: ["AI", "evidence"],
      links: ["Claim One", "Claim Two"],
    },
  );
});

Deno.test("wiki page bodies preserve Markdown paragraphs", () => {
  assert.equal(
    validateWikiPage({
      ...page,
      body: "First paragraph.\n\nSecond paragraph.",
    }).body,
    "First paragraph.\n\nSecond paragraph.",
  );
});

Deno.test("wiki pages reject malformed model output", () => {
  const invalidPages = [
    { ...page, type: "source" },
    { ...page, title: "Broken [[title]]" },
    { ...page, title: "Broken\ntitle" },
    { ...page, tags: "research" },
    { ...page, links: ["Valid", 42] },
  ];

  for (const invalidPage of invalidPages) {
    assert.throws(() => validateWikiPage(invalidPage));
  }
});

Deno.test("wiki links are validated and rendered consistently", () => {
  assert.equal(renderWikiLink("Claim One"), "[[Claim One]]");
  assert.throws(() => renderWikiLink("Broken ]] link"), /delimiters/);
});

Deno.test("wiki Markdown rendering is deterministic and retains provenance", () => {
  const hash = "a".repeat(64);
  assert.equal(
    renderWikiPage(page, [{
      title: "Research report",
      url: "https://example.test/report",
      contentHash: hash,
    }]),
    `---
title: "Evidence Map"
type: synthesis
tags: ["research"]
links: ["Claim One"]
---

# Evidence Map

The available evidence supports the main claim.

## Related

- [[Claim One]]

## Sources

- [Research report](<https://example.test/report>); SHA-256: \`${hash}\` <!-- synthesis-source:${hash} -->
`,
  );
});

Deno.test("rendered wiki pages parse back into the same domain value", () => {
  const rendered = renderWikiPage(page, [{
    title: "Research report",
    contentHash: "c".repeat(64),
  }]);
  assert.deepEqual(parseWikiPage(rendered), page);
  assert.deepEqual(parseWikiPage(rendered.replaceAll("\n", "\r\n")), page);
});

Deno.test("wiki parsing rejects ambiguous or inconsistent Markdown", () => {
  const rendered = renderWikiPage(page, []);
  assert.throws(
    () => parseWikiPage(rendered.replace("# Evidence Map", "# Other title")),
    /heading does not match/,
  );
  assert.throws(
    () =>
      parseWikiPage(
        rendered.replace("type: synthesis", "type: synthesis\ntype: concept"),
      ),
    /duplicated/,
  );
  assert.throws(
    () => validateWikiPage({ ...page, body: "Claim.\n\n## Sources\n\nManual" }),
    /compiler-managed/,
  );
});

Deno.test("wiki sources require valid hashes and HTTP URLs", () => {
  assert.match(
    renderWikiPage(page, [{
      title: "S".repeat(200),
      contentHash: "a".repeat(64),
    }]),
    new RegExp(`- ${"S".repeat(200)}; SHA-256:`),
  );
  assert.throws(
    () =>
      renderWikiPage(page, [{
        title: "S".repeat(501),
        contentHash: "a".repeat(64),
      }]),
    /Source title exceeds 500/,
  );
  assert.throws(
    () => renderWikiPage(page, [{ title: "Source", contentHash: "invalid" }]),
    /SHA-256/,
  );
  assert.throws(
    () =>
      renderWikiPage(page, [{
        title: "Source",
        url: "file:///private/source.txt",
        contentHash: "b".repeat(64),
      }]),
    /HTTP or HTTPS/,
  );
});

Deno.test("wiki indexes group and sort pages deterministically", () => {
  assert.equal(
    renderWikiIndex([
      {
        title: "Zeta pathway",
        type: "concept",
        summary: "First line.\nSecond line.",
      },
      {
        title: "Alpha trial",
        type: "entity",
        summary: "A named clinical trial.",
      },
      {
        title: "Beta pathway",
        type: "concept",
        summary: "A biological mechanism.",
      },
    ]),
    `# Synthesis Wiki

This index is maintained automatically from compiled wiki pages.

## Entities

- [[Alpha trial]] — A named clinical trial.

## Concepts

- [[Beta pathway]] — A biological mechanism.
- [[Zeta pathway]] — First line. Second line.
`,
  );
});

Deno.test("wiki logs use a stable machine-readable format", () => {
  const hash = "d".repeat(64);
  assert.equal(
    renderWikiLogEntry({
      timestamp: "2026-08-02T12:34:56.789Z",
      operation: "ingest",
      subject: "Clinical evidence review",
      contentHash: hash,
      changes: [
        { action: "create", pageTitle: "Alpha trial", pageType: "entity" },
        {
          action: "contradict",
          pageTitle: "Treatment effect",
          pageType: "concept",
        },
      ],
    }),
    `## [2026-08-02T12:34:56.789Z] ingest | Clinical evidence review
- Source SHA-256: \`${hash}\`
- create entity: [[Alpha trial]]
- contradict concept: [[Treatment effect]]
`,
  );

  assert.throws(
    () =>
      renderWikiLogEntry({
        timestamp: "yesterday",
        operation: "ingest",
        subject: "Invalid",
        changes: [],
      }),
    /ISO UTC/,
  );
});
