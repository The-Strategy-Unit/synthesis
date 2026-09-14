import assert from "node:assert/strict";

import { config, validateRuntimeConfiguration } from "./config.ts";

function runtime(overrides: {
  host?: string;
  trustProxyAuth?: boolean;
  publicOrigin?: string;
  allowedEmails?: string[];
  ingesterEmails?: string[];
  llmApiBase?: string;
}) {
  return {
    ...config,
    host: overrides.host ?? "127.0.0.1",
    security: {
      ...config.security,
      trustProxyAuth: overrides.trustProxyAuth ?? false,
      publicOrigin: overrides.publicOrigin,
      allowedEmails: overrides.allowedEmails ?? [],
      ingesterEmails: overrides.ingesterEmails ?? [],
    },
    llm: {
      ...config.llm,
      apiBase: overrides.llmApiBase ?? "http://localhost:11434/v1",
    },
    embed: {
      ...config.embed,
      apiBase: "http://localhost:11434/v1",
    },
  };
}

Deno.test("runtime configuration keeps loopback local mode safe by default", () => {
  assert.doesNotThrow(() => validateRuntimeConfiguration(runtime({})));
});

Deno.test("runtime configuration rejects an unauthenticated network listener", () => {
  assert.throws(
    () => validateRuntimeConfiguration(runtime({ host: "0.0.0.0" })),
    /non-loopback listeners require/,
  );
  assert.throws(
    () => validateRuntimeConfiguration(runtime({ trustProxyAuth: true })),
    /Trusted proxy mode/,
  );
  assert.doesNotThrow(() =>
    validateRuntimeConfiguration(runtime({
      host: "0.0.0.0",
      trustProxyAuth: true,
      publicOrigin: "https://synthesis.example",
      allowedEmails: ["viewer@example.com", "editor@example.com"],
      ingesterEmails: ["editor@example.com"],
    }))
  );
});

Deno.test("runtime configuration validates environment provider endpoints", () => {
  assert.throws(
    () =>
      validateRuntimeConfiguration(runtime({
        llmApiBase: "http://provider.example/v1",
      })),
    /must use HTTPS/,
  );
});
