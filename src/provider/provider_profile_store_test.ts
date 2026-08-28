import assert from "node:assert/strict";

import { ProviderProfileError } from "./provider_profile.ts";
import {
  type ProfileFileStore,
  ProviderProfileStore,
} from "./provider_profile_store.ts";

const profile = {
  displayName: "Ollama",
  llm: { apiBase: "http://localhost:11434/v1", model: "chat" },
  embedding: {
    apiBase: "http://localhost:11434/v1",
    model: "embed",
    dimensions: 1024,
  },
};

Deno.test("provider profile store persists only validated metadata", async () => {
  const files: { written?: string } & ProfileFileStore = {
    read: () => Promise.resolve(""),
    write: (_path, content) => {
      files.written = content;
      return Promise.resolve();
    },
  };
  const store = new ProviderProfileStore("settings.json", files);
  const saved = await store.save({ ...profile, apiKey: "must-not-persist" });

  assert.equal(saved.id, "default");
  assert.ok(files.written);
  assert.doesNotMatch(files.written!, /must-not-persist|apiKey/);
});

Deno.test("provider profile store treats a missing settings file as unconfigured", async () => {
  const files: ProfileFileStore = {
    read: () => Promise.reject(new Deno.errors.NotFound()),
    write: () => Promise.resolve(),
  };
  assert.equal(
    await new ProviderProfileStore("settings.json", files).load(),
    null,
  );
});

Deno.test("provider profile store rejects malformed saved settings", async () => {
  const files: ProfileFileStore = {
    read: () => Promise.resolve("{not json"),
    write: () => Promise.resolve(),
  };
  await assert.rejects(
    new ProviderProfileStore("settings.json", files).load(),
    ProviderProfileError,
  );
});
