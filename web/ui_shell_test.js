import assert from "node:assert/strict";

import { initialShellState, queueBadge, reduceShellState } from "./ui_shell.js";

Deno.test("shell disclosures are mutually exclusive and dismissible", () => {
  let state = initialShellState();

  state = reduceShellState(state, { type: "toggle-tools" });
  assert.deepEqual(state, {
    navigationCollapsed: false,
    navigationOpen: false,
    pageListCollapsed: false,
    sourceOpen: false,
    toolsOpen: true,
  });

  state = reduceShellState(state, { type: "toggle-source" });
  assert.deepEqual(state, {
    navigationCollapsed: false,
    navigationOpen: false,
    pageListCollapsed: false,
    sourceOpen: true,
    toolsOpen: false,
  });

  state = reduceShellState(state, { type: "toggle-navigation" });
  assert.deepEqual(state, {
    navigationCollapsed: false,
    navigationOpen: true,
    pageListCollapsed: false,
    sourceOpen: false,
    toolsOpen: false,
  });

  assert.deepEqual(
    reduceShellState(state, { type: "dismiss" }),
    initialShellState(),
  );
});

Deno.test("workspace and page-list panes collapse independently", () => {
  let state = initialShellState();
  state = reduceShellState(state, { type: "toggle-navigation-collapse" });
  state = reduceShellState(state, { type: "toggle-page-list" });
  assert.equal(state.navigationCollapsed, true);
  assert.equal(state.pageListCollapsed, true);

  state = reduceShellState(state, { type: "dismiss" });
  assert.equal(state.navigationCollapsed, true);
  assert.equal(state.pageListCollapsed, true);
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
  assert.match(html, /id="vault-switch-btn" class="hidden"/);
  assert.match(html, /id="vault-switch-modal" class="modal"/);
  assert.doesNotMatch(header, /id="workspace-collapse"/);
  assert.doesNotMatch(header, /id="review-open-btn"/);
  assert.doesNotMatch(header, /id="sources-open-btn"/);

  assert.ok(navigation, "primary task navigation must exist");
  assert.match(
    html,
    /<\/nav>\s+<button id="workspace-collapse"[^>]*aria-controls="primary-nav"/,
  );
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

Deno.test("global actions are compact and vault operations explain their impact", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const css = await Deno.readTextFile(new URL("./style.css", import.meta.url));

  assert.match(css, /--control-compact:\s*2\.25rem/);
  assert.match(
    css,
    /#topbar \{[^}]*\n\s+height: var\(--topbar-height\)/,
  );
  assert.match(
    css,
    /@media \(max-width: 780px\) \{[\s\S]*?#topbar \{[^}]*height: auto;[^}]*min-height: var\(--topbar-height\)/,
  );
  assert.match(
    css,
    /#workspace-collapse \{[\s\S]*?top: 50%;[\s\S]*?transform: translateY\(-50%\)/,
  );
  assert.match(
    css,
    /\.topbar-actions \.primary-action,[\s\S]*?min-height: var\(--control-compact\)/,
  );
  assert.match(
    css,
    /#search-input \{[\s\S]*?height: var\(--control-compact\)/,
  );
  assert.match(
    html,
    /<h2 id="vault-health-heading">Health &amp; indexing<\/h2>/,
  );
  assert.match(html, /<section class="recovery-actions"/);
  for (
    const consequence of [
      "Check authoritative files without changing them",
      "Reset derived search, proposal, and graph state",
      "Send wiki text to the selected embedding provider",
      "Restore the previous live wiki revisions",
    ]
  ) {
    assert.match(html, new RegExp(`<small>${consequence}</small>`));
  }
});
