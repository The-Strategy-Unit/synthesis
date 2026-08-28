import assert from "node:assert/strict";

import {
  KeyringSecretStore,
  type ProviderSecret,
  SecretStoreError,
} from "./secret_store.ts";

function fakeKeyring() {
  const values = new Map<string, string>();
  const operations: string[] = [];
  const store = new KeyringSecretStore((service, account) => ({
    getPassword: () => Promise.resolve(values.get(`${service}:${account}`)),
    setPassword: (value) => {
      operations.push(`set:${service}:${account}`);
      values.set(`${service}:${account}`, value);
      return Promise.resolve();
    },
    deletePassword: () => {
      operations.push(`delete:${service}:${account}`);
      values.delete(`${service}:${account}`);
      return Promise.resolve();
    },
  }));
  return { operations, store, values };
}

Deno.test("keychain adapter keeps LLM and embedding API keys separate", async () => {
  const { store, values } = fakeKeyring();
  await store.set("llm", " llm-key ");
  await store.set("embedding", "embedding-key");

  assert.equal(await store.get("llm"), "llm-key");
  assert.equal(await store.get("embedding"), "embedding-key");
  assert.equal(values.size, 2);
});

Deno.test("keychain adapter reports missing secrets as null and delegates deletion", async () => {
  const { operations, store } = fakeKeyring();
  assert.equal(await store.get("llm"), null);

  await store.set("llm", "key");
  await store.delete("llm");
  assert.equal(await store.get("llm"), null);
  assert.deepEqual(operations, [
    "set:com.strategyunit.synthesis:llm",
    "delete:com.strategyunit.synthesis:llm",
  ]);
});

Deno.test("keychain adapter rejects blank, oversized, and control-character secrets", async () => {
  const { store, values } = fakeKeyring();
  const invalid = ["", "   ", "key\nvalue", "x".repeat(4097)];

  for (const value of invalid) {
    await assert.rejects(
      store.set("llm" as ProviderSecret, value),
      SecretStoreError,
    );
  }
  assert.equal(values.size, 0);
});
