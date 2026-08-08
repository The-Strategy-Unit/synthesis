import assert from "node:assert/strict";

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
    assert.ok(value, `${variable} must be a six-digit color`);
    assert.ok(
      contrast("#ffffff", value) >= 4.5,
      `${variable} must retain 4.5:1 contrast with white text`,
    );
  }
});
