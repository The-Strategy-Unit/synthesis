import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import type { ProviderProfile } from "./provider_profile.ts";
import {
  checkProviderConnection,
  checkProviderReadiness,
  diagnoseProviders,
  embeddingIdentity,
  environmentProviders,
  providerMode,
  ProviderRuntimeError,
  resolveActiveProviders,
} from "./provider_runtime.ts";
import type { SecretStore } from "./secret_store.ts";

const profile: ProviderProfile = {
  id: "default",
  displayName: "Test provider",
  llm: { apiBase: "https://api.example.test/v1", model: "chat-model" },
  embedding: {
    apiBase: "https://embed.example.test/v1",
    model: "embed-model",
    dimensions: config.embed.dimensions,
  },
};

Deno.test("embedding identity records the Nomic retrieval input format", () => {
  const nomic = JSON.parse(embeddingIdentity({
    apiBase: "http://registry.example:5000/v1/",
    model: "registry.example:5000/nomic-ai/nomic-embed-text-v2-moe:latest",
  })) as Record<string, unknown>;
  assert.equal(nomic.inputFormat, "nomic-v2-task-prefixes-v1");

  const generic = JSON.parse(embeddingIdentity({
    apiBase: "https://embed.example.test/v1",
    model: "generic-embed-model",
  })) as Record<string, unknown>;
  assert.equal("inputFormat" in generic, false);
});

function secrets(
  values: Partial<Record<"llm" | "embedding", string>>,
): SecretStore {
  return {
    get: (kind) => Promise.resolve(values[kind] ?? null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

Deno.test("saved profile resolves keys at runtime without persisting them", async () => {
  const providers = await resolveActiveProviders(
    { load: () => Promise.resolve(profile) },
    secrets({ llm: "llm-secret", embedding: "embedding-secret" }),
  );
  assert.deepEqual(providers, {
    source: "profile",
    llm: {
      apiBase: profile.llm.apiBase,
      apiKey: "llm-secret",
      extractModel: "chat-model",
      consolidateModel: "chat-model",
      integrateModel: "chat-model",
      rewriteModel: "chat-model",
    },
    embedding: {
      apiBase: profile.embedding.apiBase,
      apiKey: "embedding-secret",
      model: "embed-model",
    },
  });
});

Deno.test("runtime resolution preserves environment configuration when no profile exists", async () => {
  let keychainLoaded = false;
  const providers = await resolveActiveProviders(
    { load: () => Promise.resolve(null) },
    () => {
      keychainLoaded = true;
      return Promise.resolve(secrets({}));
    },
  );
  assert.equal(providers.source, "environment");
  assert.equal(keychainLoaded, false);
  assert.equal(providers.llm.apiBase, config.llm.apiBase);
  assert.equal(providers.embedding.apiBase, config.embed.apiBase);
});

Deno.test("runtime resolution rejects missing keys and incompatible dimensions", async () => {
  await assert.rejects(
    resolveActiveProviders(
      { load: () => Promise.resolve(profile) },
      secrets({}),
    ),
    /llm API key is missing/,
  );
  await assert.rejects(
    resolveActiveProviders(
      {
        load: () =>
          Promise.resolve({
            ...profile,
            embedding: { ...profile.embedding, dimensions: 64 },
          }),
      },
      secrets({ llm: "key", embedding: "key" }),
    ),
    /Embedding dimensions/,
  );
});

Deno.test("provider health check uses /models and redacts transport failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (input, init) => {
      assert.equal(input, "https://api.example.test/v1/models");
      assert.deepEqual(init?.headers, { Authorization: "Bearer secret" });
      return Promise.resolve(Response.json({ data: [] }));
    };
    assert.deepEqual(
      await checkProviderConnection(
        "https://api.example.test/v1",
        "secret",
      ),
      [],
    );

    globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 401 }));
    await assert.rejects(
      checkProviderConnection("https://api.example.test/v1", "secret"),
      /Provider rejected connection \(401\)/,
    );

    globalThis.fetch = () => Promise.reject(new Error("key=secret"));
    await assert.rejects(
      checkProviderConnection("https://api.example.test/v1", "secret"),
      ProviderRuntimeError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider readiness checks model lists without loading models", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const providers = environmentProviders();
    const availableModels = [
      ...new Set([
        providers.llm.extractModel,
        providers.llm.consolidateModel,
        providers.llm.integrateModel,
        providers.llm.rewriteModel,
        providers.embedding.model,
      ]),
    ].map((id) => ({ id }));
    const requests: string[] = [];
    globalThis.fetch = (input, init) => {
      requests.push(String(input));
      assert.equal(init?.method, undefined);
      assert.equal(init?.body, undefined);
      return Promise.resolve(Response.json({ data: availableModels }));
    };

    const ready = await checkProviderReadiness(providers);
    assert.equal(ready.ready, true);
    assert.equal(ready.mode, "local");
    assert.deepEqual(ready.chat.missingModels, []);
    assert.deepEqual(ready.embedding.missingModels, []);
    assert.deepEqual(requests, [`${providers.llm.apiBase}/models`]);

    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        data: availableModels.filter(({ id }) =>
          id !== providers.embedding.model
        ),
      }));
    const missing = await checkProviderReadiness(providers);
    assert.equal(missing.ready, false);
    assert.deepEqual(missing.embedding.missingModels, [
      providers.embedding.model,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider diagnostics identify local mode and missing models", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const providers = environmentProviders();
    assert.equal(providerMode(providers), "local");
    assert.equal(
      providerMode({
        llm: { apiBase: "http://[::1]:11434/v1" },
        embedding: { apiBase: "http://[::1]:11434/v1" },
      }),
      "local",
    );
    assert.equal(
      providerMode({
        llm: { ...providers.llm, apiBase: "https://llm.example.test/v1" },
        embedding: providers.embedding,
      }),
      "remote",
    );

    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(Response.json({ data: [] }));
    };
    const missing = await diagnoseProviders(providers);
    assert.equal(calls, 1, "a shared Ollama endpoint should be checked once");
    assert.equal(missing.mode, "local");
    assert.equal(missing.ready, false);
    assert.equal(missing.chat.probe.attempted, false);
    assert.equal(missing.embedding.probe.attempted, false);
    assert.deepEqual(missing.embedding.missingModels, [
      providers.embedding.model,
    ]);
    assert.doesNotMatch(JSON.stringify(missing), /ollama.*key/i);

    const availableModels = [
      ...new Set([
        providers.llm.extractModel,
        providers.llm.consolidateModel,
        providers.llm.integrateModel,
        providers.llm.rewriteModel,
        providers.embedding.model,
      ]),
    ].map((id) => ({ id }));
    let embeddingBody: Record<string, unknown> | undefined;
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Promise.resolve(Response.json({ data: availableModels }));
      }
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(Response.json({
          choices: [{
            finish_reason: "stop",
            message: { content: '{"ok":true}' },
          }],
        }));
      }
      if (url.endsWith("/embeddings")) {
        embeddingBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return Promise.resolve(Response.json({
          data: [{ embedding: Array(config.embed.dimensions).fill(0) }],
        }));
      }
      throw new Error(`Unexpected provider URL ${url}`);
    };
    const ready = await diagnoseProviders(providers);
    assert.equal(ready.ready, true);
    assert.equal(ready.chat.probe.ok, true);
    assert.equal(ready.embedding.probe.ok, true);
    assert.equal(ready.embedding.actualDimensions, config.embed.dimensions);
    assert.equal(ready.embedding.expectedDimensions, config.embed.dimensions);
    assert.deepEqual(embeddingBody, {
      model: providers.embedding.model,
      input: "search_query: Synthesis provider compatibility check",
      dimensions: config.embed.dimensions,
    });
    assert.equal(typeof ready.chat.probe.latencyMs, "number");
    assert.equal(typeof ready.embedding.probe.latencyMs, "number");

    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Promise.resolve(Response.json({ data: availableModels }));
      }
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(Response.json({
          choices: [{
            finish_reason: "stop",
            message: { content: '{"ok":true}' },
          }],
        }));
      }
      return Promise.resolve(Response.json({
        data: [{ embedding: Array(64).fill(0) }],
      }));
    };
    const incompatible = await diagnoseProviders(providers);
    assert.equal(incompatible.ready, false);
    assert.equal(incompatible.embedding.actualDimensions, 64);
    assert.match(
      incompatible.embedding.probe.error ?? "",
      /returned 64 dimensions/,
    );

    globalThis.fetch = () => Promise.resolve(Response.json({ models: [] }));
    await assert.rejects(
      checkProviderConnection(providers.llm.apiBase, providers.llm.apiKey),
      /invalid model list/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
