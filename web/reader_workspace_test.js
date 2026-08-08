import assert from "node:assert/strict";

import {
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
