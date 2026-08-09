import assert from "node:assert/strict";

import {
  providerCapabilities,
  providerEmptyState,
  providerPresentation,
} from "./provider_readiness.js";

Deno.test("provider state is explicit without overstating configuration", () => {
  assert.deepEqual(providerPresentation({ phase: "checking", mode: "local" }), {
    badgeMode: "checking",
    text: "Local AI · checking",
    description: "Checking configured model availability in the background.",
  });
  assert.equal(
    providerPresentation({ phase: "configured", mode: "remote" }).text,
    "Remote AI · configured",
  );
  assert.equal(
    providerPresentation({ phase: "ready", mode: "local" }).text,
    "Local AI · ready",
  );
  assert.deepEqual(
    providerPresentation({ phase: "unavailable", mode: "local" }),
    {
      badgeMode: "unavailable",
      text: "Knowledge-only · AI unavailable",
      description:
        "Existing wiki pages, evidence, review queues, and keyword search remain available.",
    },
  );
});

Deno.test("offline provider state selects deterministic keyword search", () => {
  for (const phase of ["configured", "checking", "unavailable"]) {
    assert.deepEqual(providerCapabilities(phase), {
      modelActions: false,
      searchMode: "keyword",
    });
  }
  assert.deepEqual(providerCapabilities("ready"), {
    modelActions: true,
    searchMode: "hybrid",
  });
  assert.deepEqual(providerEmptyState("unavailable"), {
    action: "configure-provider",
    label: "Configure AI provider",
  });
  assert.deepEqual(providerEmptyState("ready"), {
    action: "add-source",
    label: "Add your first source",
  });
});

Deno.test("model-dependent controls expose the shared provider status", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assert.match(
    html,
    /<button id="provider-mode"[^>]*aria-live="polite"/,
  );
  for (
    const id of [
      "add-source-btn",
      "reader-add-source",
      "ask-open-btn",
      "proposal-approve",
      "ingest-btn",
      "discoveries-scan",
      "lint-analyze",
    ]
  ) {
    const control = html.match(new RegExp(`<button id="${id}"[^>]*>`))?.[0];
    assert.ok(control, `${id} must exist`);
    assert.match(control, /aria-describedby="provider-mode"/);
  }
});
