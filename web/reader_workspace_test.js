import assert from "node:assert/strict";

import {
  compactEvidenceText,
  evidenceActionLabel,
  evidenceSourceLocation,
  evidenceSummary,
  initialReaderState,
  reduceReaderState,
} from "./reader_workspace.js";

Deno.test("selecting a page restores the reader and evidence context", () => {
  let state = reduceReaderState(initialReaderState(), {
    type: "show-connections",
  });
  state = reduceReaderState(state, { type: "select-note", noteId: 42 });

  assert.deepEqual(state, {
    evidenceOpen: true,
    selectedNoteId: 42,
    view: "page",
  });

  state = reduceReaderState(state, { type: "hide-evidence" });
  assert.equal(state.evidenceOpen, false);
  assert.equal(
    reduceReaderState(state, { type: "show-connections" }).selectedNoteId,
    42,
    "map exploration must not discard the active page",
  );
});

Deno.test("reader state rejects invalid page selections", () => {
  const state = initialReaderState();
  assert.equal(
    reduceReaderState(state, { type: "select-note", noteId: 0 }),
    state,
  );
  assert.equal(
    reduceReaderState(state, { type: "toggle-evidence" }),
    state,
  );
});

Deno.test("evidence summary distinguishes reviewed links from semantic links", () => {
  assert.deepEqual(
    evidenceSummary({
      claims: [{ text: "Claim" }, { text: "Second" }],
      related: [
        { kind: "explicit" },
        { kind: "semantic" },
        { kind: "semantic" },
      ],
      sources: [{ id: 1 }],
    }),
    {
      claimCount: 2,
      explicitLinkCount: 1,
      semanticLinkCount: 2,
      sourceCount: 1,
    },
  );
});

Deno.test("evidence text stays scannable without discarding the full claim", () => {
  const longClaim = `A structured claim ${"with evidence ".repeat(30)}`;
  const compact = compactEvidenceText(longClaim, 80);
  assert.equal(compact.truncated, true);
  assert.ok(compact.preview.length <= 81);
  assert.match(compact.preview, /…$/);
  assert.equal(compact.fullText, longClaim.trim());
  assert.deepEqual(compactEvidenceText("  Short\n claim  "), {
    fullText: "Short claim",
    preview: "Short claim",
    truncated: false,
  });
});

Deno.test("source evidence uses readable page ranges and actions", () => {
  assert.equal(
    evidenceSourceLocation({
      sourcePages: Array.from({ length: 50 }, (_, index) => index + 1),
    }),
    "pages 1–50",
  );
  assert.equal(
    evidenceSourceLocation({ sourcePages: [1, 2, 4] }),
    "pages 1–2, 4",
  );
  assert.equal(evidenceSourceLocation({}), null);
  assert.equal(evidenceActionLabel("new"), "Added");
  assert.equal(evidenceActionLabel("merge"), "Updated");
  assert.equal(evidenceActionLabel("contradict"), "Conflict recorded");
  assert.equal(evidenceActionLabel("unknown"), null);
});

Deno.test("reader workspace replaces the note modal and demotes the graph", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assert.match(html, /id="reader-panel"/);
  assert.match(html, /id="note-content" class="hidden"/);
  assert.match(html, /id="evidence-panel" class="hidden"/);
  assert.match(html, /id="page-view-btn" class="active"/);
  assert.match(html, /id="graph-panel" class="hidden"/);
  assert.doesNotMatch(html, /id="note-modal"/);
});
