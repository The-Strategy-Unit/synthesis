import assert from "node:assert/strict";

import { initialShellState, queueBadge, reduceShellState } from "./ui_shell.js";

Deno.test("shell disclosures are mutually exclusive and dismissible", () => {
  let state = initialShellState();

  state = reduceShellState(state, { type: "toggle-tools" });
  assert.deepEqual(state, {
    navigationOpen: false,
    sourceOpen: false,
    toolsOpen: true,
  });

  state = reduceShellState(state, { type: "toggle-source" });
  assert.deepEqual(state, {
    navigationOpen: false,
    sourceOpen: true,
    toolsOpen: false,
  });

  state = reduceShellState(state, { type: "toggle-navigation" });
  assert.deepEqual(state, {
    navigationOpen: true,
    sourceOpen: false,
    toolsOpen: false,
  });

  assert.deepEqual(
    reduceShellState(state, { type: "dismiss" }),
    initialShellState(),
  );
});

Deno.test("queue badges remain concise and accessible", () => {
  assert.deepEqual(queueBadge(0, "pending review", "pending reviews"), {
    hidden: true,
    label: "No pending reviews",
    text: "0",
  });
  assert.deepEqual(queueBadge(1, "pending review", "pending reviews"), {
    hidden: false,
    label: "1 pending review",
    text: "1",
  });
  assert.deepEqual(queueBadge(112, "pending review", "pending reviews"), {
    hidden: false,
    label: "112 pending reviews",
    text: "99+",
  });
});

Deno.test("application shell keeps global, task, and vault actions separate", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const header = html.match(/<header id="topbar">([\s\S]*?)<\/header>/)?.[0];
  const navigation = html.match(
    /<nav id="primary-nav"([\s\S]*?)<\/nav>/,
  )?.[0];
  const sourcePanel = html.match(
    /<aside id="source-panel"([\s\S]*?)<\/aside>/,
  )?.[0];

  assert.ok(header, "global header must exist");
  assert.match(header, /id="search-input"/);
  assert.match(header, /id="add-source-btn"/);
  assert.match(header, /id="vault-menu-btn"/);
  assert.doesNotMatch(header, /id="review-open-btn"/);
  assert.doesNotMatch(header, /id="sources-open-btn"/);

  assert.ok(navigation, "primary task navigation must exist");
  for (
    const id of [
      "wiki-nav-btn",
      "review-open-btn",
      "discoveries-open-btn",
      "ask-open-btn",
      "sources-open-btn",
      "lint-open-btn",
    ]
  ) {
    assert.match(navigation, new RegExp(`id="${id}"`));
  }

  assert.ok(sourcePanel, "focused source panel must exist");
  assert.match(sourcePanel, /class="source-panel hidden"/);
  assert.match(sourcePanel, /id="ingest-input"/);
  assert.match(sourcePanel, /id="ingest-file"/);
  assert.match(sourcePanel, /id="ingest-status" role="status"/);
});
