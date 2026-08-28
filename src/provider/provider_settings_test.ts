import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import type { ProviderProfile } from "./provider_profile.ts";
import {
  configureProviders,
  providerSettingsStatus,
} from "./provider_settings.ts";
import type { ProviderSecret, SecretStore } from "./secret_store.ts";

const profile: ProviderProfile = {
  id: "default",
  displayName: "Clinical research provider",
  llm: {
    apiBase: "https://llm.example.test/v1",
    model: "synthesis-model",
  },
  embedding: {
    apiBase: "https://embed.example.test/v1",
    model: "embedding-model",
    dimensions: config.embed.dimensions,
  },
};

class MemorySecrets implements SecretStore {
  values = new Map<ProviderSecret, string>();

  get(secret: ProviderSecret): Promise<string | null> {
    return Promise.resolve(this.values.get(secret) ?? null);
  }

  set(secret: ProviderSecret, value: string): Promise<void> {
    this.values.set(secret, value);
    return Promise.resolve();
  }

  delete(secret: ProviderSecret): Promise<void> {
    this.values.delete(secret);
    return Promise.resolve();
  }
}

function compatibleProviderResponse(input: string | URL | Request): Response {
  const url = String(input);
  if (url.endsWith("/models")) {
    const id = url.startsWith(profile.embedding.apiBase)
      ? profile.embedding.model
      : profile.llm.model;
    return Response.json({ data: [{ id }] });
  }
  if (url.endsWith("/chat/completions")) {
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
    });
  }
  if (url.endsWith("/embeddings")) {
    return Response.json({
      data: [{ embedding: Array(config.embed.dimensions).fill(0) }],
    });
  }
  throw new Error(`Unexpected provider request: ${url}`);
}

Deno.test("provider settings status never returns secret values", async () => {
  let keychainOpened = false;
  assert.deepEqual(
    await providerSettingsStatus(
      {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(profile),
      },
      () => {
        keychainOpened = true;
        return Promise.resolve(new MemorySecrets());
      },
    ),
    {
      configured: false,
      profile: null,
      llmKeyStored: false,
      embeddingKeyStored: false,
    },
  );
  assert.equal(keychainOpened, false);

  const secrets = new MemorySecrets();
  secrets.values.set("llm", "secret-value");
  const status = await providerSettingsStatus(
    {
      load: () => Promise.resolve(profile),
      save: () => Promise.resolve(profile),
    },
    secrets,
  );
  assert.equal(status.configured, false);
  assert.equal(status.llmKeyStored, true);
  assert.equal(status.embeddingKeyStored, false);
  assert.doesNotMatch(JSON.stringify(status), /secret-value/);
});

Deno.test("provider configuration checks compatibility before saving", async () => {
  const originalFetch = globalThis.fetch;
  const secrets = new MemorySecrets();
  const calls: string[] = [];
  let saved: unknown;
  try {
    globalThis.fetch = (input, init) => {
      calls.push(String(input));
      assert.match(
        new Headers(init?.headers).get("Authorization") ?? "",
        /^Bearer (llm|embedding)-key$/,
      );
      return Promise.resolve(compatibleProviderResponse(input));
    };
    const status = await configureProviders(
      {
        load: () => Promise.resolve(null),
        save: (value) => {
          saved = value;
          return Promise.resolve(profile);
        },
      },
      secrets,
      {
        profile,
        llmApiKey: "llm-key",
        embeddingApiKey: "embedding-key",
      },
    );
    assert.deepEqual(calls.sort(), [
      "https://embed.example.test/v1/embeddings",
      "https://embed.example.test/v1/models",
      "https://llm.example.test/v1/chat/completions",
      "https://llm.example.test/v1/models",
    ]);
    assert.deepEqual(saved, profile);
    assert.equal(status.configured, true);
    assert.doesNotMatch(JSON.stringify(status), /llm-key|embedding-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider updates retain stored keys when key fields are empty", async () => {
  const originalFetch = globalThis.fetch;
  const secrets = new MemorySecrets();
  secrets.values.set("llm", "stored-llm-key");
  secrets.values.set("embedding", "stored-embedding-key");
  const authorizations: string[] = [];
  try {
    globalThis.fetch = (input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("Authorization") ?? "",
      );
      return Promise.resolve(compatibleProviderResponse(input));
    };
    await configureProviders(
      {
        load: () => Promise.resolve(profile),
        save: () => Promise.resolve(profile),
      },
      secrets,
      {
        profile: { ...profile, displayName: "Updated provider" },
        llmApiKey: "",
        embeddingApiKey: undefined,
      },
    );

    assert.deepEqual(authorizations.sort(), [
      "Bearer stored-embedding-key",
      "Bearer stored-embedding-key",
      "Bearer stored-llm-key",
      "Bearer stored-llm-key",
    ]);
    assert.equal(await secrets.get("llm"), "stored-llm-key");
    assert.equal(await secrets.get("embedding"), "stored-embedding-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider configuration restores secrets when profile save fails", async () => {
  const originalFetch = globalThis.fetch;
  const secrets = new MemorySecrets();
  secrets.values.set("llm", "old-llm-key");
  secrets.values.set("embedding", "old-embedding-key");
  try {
    globalThis.fetch = (input) =>
      Promise.resolve(compatibleProviderResponse(input));
    await assert.rejects(
      configureProviders(
        {
          load: () => Promise.resolve(profile),
          save: () => Promise.reject(new Error("profile write failed")),
        },
        secrets,
        {
          profile,
          llmApiKey: "new-llm-key",
          embeddingApiKey: "new-embedding-key",
        },
      ),
      /profile write failed/,
    );
    assert.equal(await secrets.get("llm"), "old-llm-key");
    assert.equal(await secrets.get("embedding"), "old-embedding-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider configuration rejects incompatible vault dimensions", async () => {
  const secrets = new MemorySecrets();
  await assert.rejects(
    configureProviders(
      {
        load: () => Promise.resolve(null),
        save: () => Promise.reject(new Error("must not save")),
      },
      secrets,
      {
        profile: {
          ...profile,
          embedding: {
            ...profile.embedding,
            dimensions: config.embed.dimensions === 768 ? 4096 : 768,
          },
        },
        llmApiKey: "llm-key",
        embeddingApiKey: "embedding-key",
      },
    ),
    /must match this vault/,
  );
  assert.equal(secrets.values.size, 0);
});
