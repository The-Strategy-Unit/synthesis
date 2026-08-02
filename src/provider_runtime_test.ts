import assert from "node:assert/strict";

import { config } from "./config.ts";
import type { ProviderProfile } from "./provider_profile.ts";
import {
  checkProviderConnection,
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
    await checkProviderConnection("https://api.example.test/v1", "secret");

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
