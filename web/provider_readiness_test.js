import assert from "node:assert/strict";

import {
  ollamaPreset,
  providerCapabilities,
  providerEmptyState,
  providerPresentation,
  searchAvailabilityPresentation,
} from "./provider_readiness.js";

Deno.test("local Ollama preset matches the vault embedding configuration", () => {
  assert.deepEqual(ollamaPreset(768), {
    displayName: "Local Ollama",
    llmApiBase: "http://localhost:11434/v1",
    llmModel: "qwen3.6:27b",
    embeddingApiBase: "http://localhost:11434/v1",
    embeddingModel: "nomic-embed-text-v2-moe:latest",
    embeddingDimensions: 768,
  });
  assert.equal(ollamaPreset(256).embeddingDimensions, 256);
  assert.equal(ollamaPreset(0).embeddingDimensions, 768);
});

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
      semanticSearch: false,
      searchMode: "keyword",
    });
  }
  assert.deepEqual(providerCapabilities("ready"), {
    modelActions: true,
    semanticSearch: false,
    searchMode: "keyword",
  });
  assert.deepEqual(providerCapabilities("ready", { complete: true }), {
    modelActions: true,
    semanticSearch: true,
    searchMode: "semantic",
  });
  assert.deepEqual(providerCapabilities("ready", { complete: false }), {
    modelActions: true,
    semanticSearch: false,
    searchMode: "keyword",
  });
  assert.match(
    providerPresentation({
      phase: "ready",
      mode: "local",
      semanticIndex: { complete: false },
    }).description,
    /needs the local semantic index/i,
  );
  assert.deepEqual(providerEmptyState("unavailable"), {
    action: "configure-provider",
    label: "Configure AI provider",
  });
  assert.deepEqual(providerEmptyState("ready"), {
    action: "add-source",
    label: "Add your first source",
  });
});

Deno.test("search availability explains the active mode and its prerequisite", () => {
  assert.deepEqual(
    searchAvailabilityPresentation({
      phase: "ready",
      mode: "remote",
      semanticIndex: { complete: false, embedded: 3, total: 8 },
    }),
    {
      mode: "keyword",
      title: "Keyword search active",
      detail:
        "AI is ready, but the semantic index is incomplete. 3 of 8 wiki pages are indexed. Searches stay on-device until indexing finishes.",
      actionLabel: "Resume semantic index",
    },
  );
  assert.deepEqual(
    searchAvailabilityPresentation({
      phase: "ready",
      mode: "local",
      semanticIndex: { complete: true, embedded: 8, total: 8 },
    }),
    {
      mode: "semantic",
      title: "Semantic search active",
      detail:
        "All 8 wiki pages are indexed. Queries use your configured local embedding provider.",
      actionLabel: null,
    },
  );
  assert.match(
    searchAvailabilityPresentation({ phase: "unavailable" }).detail,
    /on-device keyword index/,
  );
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
      "ingest-btn",
      "discoveries-scan",
      "lint-analyse",
      "rebuild-semantic-btn",
    ]
  ) {
    const control = html.match(new RegExp(`<button id="${id}"[^>]*>`))?.[0];
    assert.ok(control, `${id} must exist`);
    assert.match(control, /aria-describedby="provider-mode"/);
  }
  const approval = html.match(/<button id="proposal-approve"[^>]*>/)?.[0];
  assert.ok(approval, "proposal approval must exist");
  assert.doesNotMatch(approval, /aria-describedby="provider-mode"/);
  assert.match(
    html,
    /id="search-readiness-status" role="status"\s+aria-live="polite"/,
  );
  assert.match(
    html,
    /id="search-semantic-action"[^>]*aria-describedby="search-readiness-detail"/,
  );
});

Deno.test("an unavailable provider does not make Add source a dead end", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const app = await Deno.readTextFile(new URL("./app.js", import.meta.url));

  assert.match(
    html,
    /id="source-provider-help" class="provider-action-help hidden"/,
  );
  assert.match(html, /id="source-provider-open"/);
  assert.match(app, /addSourceButton\.disabled = false/);
  assert.match(
    app,
    /sourceProviderHelp\.classList\.toggle\("hidden", capabilities\.modelActions\)/,
  );
  assert.match(app, /sourceProviderOpen\.addEventListener\("click"/);
  assert.match(app, /openProviderModal\(addSourceButton\)/);
});
