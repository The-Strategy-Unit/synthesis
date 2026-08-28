import assert from "node:assert/strict";

import {
  ProviderProfileError,
  validateApiBase,
  validateProviderProfile,
} from "./provider_profile.ts";

const profile = {
  displayName: "Personal OpenAI-compatible provider",
  llm: { apiBase: "https://api.example.test/v1/", model: "chat-model" },
  embedding: {
    apiBase: "http://localhost:11434/v1",
    model: "embedding-model",
    dimensions: 1024,
  },
};

Deno.test("provider profiles retain only validated non-secret configuration", () => {
  assert.deepEqual(
    validateProviderProfile({ ...profile, apiKey: "must-not-persist" }),
    {
      id: "default",
      displayName: profile.displayName,
      llm: { apiBase: "https://api.example.test/v1", model: "chat-model" },
      embedding: {
        apiBase: "http://localhost:11434/v1",
        model: "embedding-model",
        dimensions: 1024,
      },
    },
  );
});

Deno.test("provider endpoints reject unsafe locations", () => {
  const unsafeEndpoints = [
    "http://api.example.test/v1",
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1?key=secret",
    "https://api.example.test/v1#secret",
    "https://api.example.test/not-v1",
    "http://127.0.0.2:11434/v1",
  ];

  for (const endpoint of unsafeEndpoints) {
    assert.throws(
      () => validateApiBase(endpoint, "apiBase"),
      ProviderProfileError,
      endpoint,
    );
  }
});

Deno.test("provider endpoints accept IPv4 and IPv6 loopback HTTP", () => {
  assert.equal(
    validateApiBase("http://127.0.0.1:11434/v1", "apiBase"),
    "http://127.0.0.1:11434/v1",
  );
  assert.equal(
    validateApiBase("http://[::1]:11434/v1", "apiBase"),
    "http://[::1]:11434/v1",
  );
});

Deno.test("provider profiles require a supported embedding dimension", () => {
  for (const dimensions of [63, 32769, 1024.5, "1024"]) {
    assert.throws(
      () =>
        validateProviderProfile({
          ...profile,
          embedding: { ...profile.embedding, dimensions },
        }),
      /embedding\.dimensions/,
    );
  }
});
