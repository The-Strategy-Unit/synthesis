import assert from "node:assert/strict";

Deno.test("graph titles have a labelled keyboard-accessible list alternative", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const app = await Deno.readTextFile(new URL("./app.js", import.meta.url));
  assert.match(html, /aria-labelledby="graph-directory-title"/);
  assert.match(html, /<label for="graph-page-filter">/);
  assert.match(
    html,
    /id="graph-page-count" role="status"\s+aria-live="polite"/,
  );
  assert.match(html, /<ul id="graph-page-list"><\/ul>/);
  assert.match(app, /\.on\("focus",/);
  assert.doesNotMatch(app, /currentZoom > uiConfig.labelZoomThreshold/);
});

Deno.test("transient workflows use labelled native modal dialogs", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  for (
    const [dialogId, titleId] of [
      ["ask-modal", "ask-title"],
      ["discoveries-modal", "discoveries-title"],
      ["lint-modal", "lint-title"],
      ["provider-modal", "provider-title"],
      ["schema-modal", "schema-title"],
      ["sources-modal", "sources-title"],
      ["vault-switch-modal", "vault-switch-title"],
      ["confirmation-modal", "confirmation-title"],
    ]
  ) {
    assert.match(
      html,
      new RegExp(
        `<dialog id="${dialogId}" class="modal"[^>]*aria-labelledby="${titleId}"`,
      ),
    );
    assert.match(html, new RegExp(`<h2 id="${titleId}">`));
  }
  assert.doesNotMatch(html, /<div id="[^"]+-modal" class="modal/);
});

Deno.test("workspace navigation and modal focus remain keyboard predictable", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const app = await Deno.readTextFile(new URL("./app.js", import.meta.url));

  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(app, /const modalReturnTargets = new WeakMap\(\)/);
  assert.match(app, /returnTarget\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(app, /globalThis\.(?:alert|confirm)\(/);
});

Deno.test("changing workflow messages are polite live regions", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const statuses = [...html.matchAll(/<[^>]+role="status"[^>]*>/g)];
  assert.ok(statuses.length >= 8);
  for (const [status] of statuses) {
    assert.match(status, /aria-live="polite"/);
  }
});

Deno.test("server work exposes accessible indeterminate progress", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const css = await Deno.readTextFile(new URL("./style.css", import.meta.url));

  assert.match(
    html,
    /id="operation-feedback"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*aria-busy="false"/,
  );
  assert.match(
    html,
    /<progress id="operation-progress"\s+aria-labelledby="operation-feedback-label"><\/progress>/,
  );
  assert.match(css, /\[role="status"\]\.operation-active::after/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

Deno.test("long ingest exposes an explicit non-submitting stop control", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assert.match(
    html,
    /<button id="ingest-cancel-btn"[^>]*type="button">Stop safely<\/button>/,
  );
});

Deno.test("drawers and focused graph workflows make hidden controls inert", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const app = await Deno.readTextFile(new URL("./app.js", import.meta.url));
  assert.match(
    html,
    /id="source-panel" class="source-panel hidden"\s+role="dialog" aria-modal="true"/,
  );
  assert.match(app, /primaryNavigation\.inert = graphMaximized \|\|/);
  assert.match(app, /workspaceCollapse\.inert = graphMaximized/);
  assert.match(
    app,
    /wikiPageSidebar\.inert = graphMaximized \|\| shellState\.pageListCollapsed/,
  );
  assert.match(app, /knowledgeToolbar\.inert = graphMaximized/);
  assert.match(app, /appWorkspace\.inert = shellState\.sourceOpen/);
  assert.match(app, /appMain\.inert = isMobile && shellState\.navigationOpen/);
});

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) =>
    Number.parseInt(value, 16) / 255
  ).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * channels[0] + 0.7152 * channels[1] +
    0.0722 * channels[2];
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

Deno.test("primary action text retains AA contrast at rest and hover", async () => {
  const css = await Deno.readTextFile(new URL("./style.css", import.meta.url));
  for (const variable of ["accent-strong", "accent-action-hover"]) {
    const value = css.match(new RegExp(`--${variable}:\\s*(#[0-9a-f]{6})`, "i"))
      ?.[1];
    assert.ok(value, `${variable} must be a six-digit colour`);
    assert.ok(
      contrast("#ffffff", value) >= 4.5,
      `${variable} must retain 4.5:1 contrast with white text`,
    );
  }
});
