import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import { discoveryEvidenceHash } from "../wiki/discovery.ts";
import { readIngestHistoryManifest } from "../vault/ingest_history.ts";
import {
  embeddingIdentity,
  environmentProviders,
} from "../provider/provider_runtime.ts";
import { createHandler } from "./routes.ts";
import { parseWikiPage, renderWikiPage } from "../wiki/wiki.ts";

function routeTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({
    name,
    permissions: "inherit",
    fn,
  });
}

async function withTempHandler(
  test: (
    handle: (request: Request) => Promise<Response>,
    db: DB,
    dir: string,
  ) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "synthesis-routes-test-" });
  const db = new DB(`${dir}/synthesis.db`);
  const originalVaultDir = config.vaultDir;
  try {
    config.vaultDir = dir;
    await test(createHandler(db), db, dir);
  } finally {
    config.vaultDir = originalVaultDir;
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function mutationHeaders(origin = "http://localhost"): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Origin": origin,
  };
}

routeTest(
  "status is minimal and carries private no-store security headers",
  async () => {
    await withTempHandler(async (handle) => {
      const response = await handle(
        new Request("http://localhost/api/status"),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.match(
        response.headers.get("Content-Security-Policy") ?? "",
        /default-src 'self'/,
      );
    });
  },
);

routeTest("UI config exposes bounded semantic graph breadth", async () => {
  await withTempHandler(async (handle) => {
    const response = await handle(
      new Request("http://localhost/api/config"),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      labelZoomThreshold: config.ui.labelZoomThreshold,
      semanticNeighbors: Math.min(
        config.link.visibleNeighbors,
        config.link.k,
      ),
      maxSemanticNeighbors: config.link.k,
    });
  });
});

routeTest(
  "vault export is streamed without a configured provider",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db, dir) => {
        await Deno.mkdir(`${dir}/notes`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/notes/offline.md`,
          "# Offline knowledge\n",
        );
        globalThis.fetch = () => {
          throw new Error("vault export must not call a provider");
        };
        const handle = createHandler(db, () => {
          throw new Error("vault export must not resolve providers");
        });

        const response = await handle(
          new Request("http://localhost/api/export"),
        );
        const archive = new Uint8Array(await response.arrayBuffer());

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Content-Type"), "application/x-tar");
        assert.match(
          response.headers.get("Content-Disposition") ?? "",
          /^attachment; filename="synthesis-vault-\d{4}-\d{2}-\d{2}\.tar"$/,
        );
        assert.equal(response.headers.get("X-Synthesis-File-Count"), "3");
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal(
          new TextDecoder().decode(archive).includes("# Offline knowledge\n"),
          true,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest("vault rebuild is confirmed, offline, and preflighted", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withTempHandler(async (_defaultHandler, db, dir) => {
      globalThis.fetch = () => {
        throw new Error("vault rebuild must not call a provider");
      };
      const handle = createHandler(db, () => {
        throw new Error("vault rebuild must not resolve providers");
      });
      const request = (body: Record<string, unknown>) =>
        handle(
          new Request("http://localhost/api/rebuild", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(body),
          }),
        );

      const unconfirmed = await request({});
      assert.equal(unconfirmed.status, 400);
      assert.equal((await unconfirmed.json()).code, "CONFIRMATION_REQUIRED");

      const rebuilt = await request({ confirm: "REBUILD" });
      assert.equal(rebuilt.status, 200);
      assert.deepEqual((await rebuilt.json()).rebuild, {
        sourceCount: 0,
        noteCount: 0,
        provenanceCount: 0,
        reset: [
          "embeddings",
          "semantic_links",
          "proposals",
          "discovery_candidates",
          "discoveries",
        ],
      });

      await Deno.mkdir(`${dir}/sources/not-a-hash`, { recursive: true });
      const invalid = await request({ confirm: "REBUILD" });
      assert.equal(invalid.status, 422);
      assert.equal((await invalid.json()).code, "VAULT_PREFLIGHT_FAILED");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

routeTest(
  "last-ingest undo is confirmed and provider-independent",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db) => {
        globalThis.fetch = () => {
          throw new Error("ingest undo must not call a provider");
        };
        const handle = createHandler(db, () => {
          throw new Error("ingest undo must not resolve providers");
        });
        const request = (body: Record<string, unknown>) =>
          handle(
            new Request("http://localhost/api/ingest/undo", {
              method: "POST",
              headers: mutationHeaders(),
              body: JSON.stringify(body),
            }),
          );

        const unconfirmed = await request({});
        assert.equal(unconfirmed.status, 400);
        assert.equal((await unconfirmed.json()).code, "CONFIRMATION_REQUIRED");

        const unavailable = await request({ confirm: "UNDO" });
        assert.equal(unavailable.status, 404);
        assert.equal((await unavailable.json()).code, "NOTHING_TO_UNDO");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest("wiki schema is created, updated, and validated", async () => {
  await withTempHandler(async (handle, _db, dir) => {
    const initialResponse = await handle(
      new Request("http://localhost/api/schema"),
    );
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.match(initial.schema, /^# Synthesis wiki schema/m);
    assert.match(initial.schema, /does not make clinical/i);

    const customSchema = `# Research vault schema

## Purpose

This vault supports evidence-aware research and organisational sensemaking. It
records source-backed knowledge, uncertainty, and connections without making
patient-specific recommendations or other consequential decisions.

## Conventions

Preserve provenance, distinguish evidence from inference, and represent
uncertainty explicitly. Use wiki links for intentional relationships.
`;
    const updateResponse = await handle(
      new Request("http://localhost/api/schema", {
        method: "PUT",
        headers: mutationHeaders(),
        body: JSON.stringify({ schema: customSchema }),
      }),
    );
    assert.equal(updateResponse.status, 200);
    assert.deepEqual(await updateResponse.json(), { schema: customSchema });
    assert.equal(await Deno.readTextFile(`${dir}/schema.md`), customSchema);

    const invalidResponse = await handle(
      new Request("http://localhost/api/schema", {
        method: "PUT",
        headers: mutationHeaders(),
        body: JSON.stringify({ schema: "Missing a heading" }),
      }),
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).code, "INVALID_SCHEMA");
    assert.equal(await Deno.readTextFile(`${dir}/schema.md`), customSchema);
  });
});

routeTest("wiki lint is read-only and provider-independent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withTempHandler(async (handle, db, dir) => {
      const filePath = `${dir}/legacy.md`;
      await Deno.writeTextFile(
        filePath,
        "# Legacy page\n\nUnsupported claim.\n",
      );
      const noteId = db.notes.addNote("Legacy page", filePath, null, "text");
      globalThis.fetch = () => {
        throw new Error("lint must not call a provider");
      };

      const response = await handle(new Request("http://localhost/api/lint"));
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.pageCount, 1);
      assert.deepEqual(
        report.issues.map((issue: { code: string }) => issue.code),
        ["legacy_format", "missing_provenance"],
      );
      assert.doesNotMatch(JSON.stringify(report), /legacy\.md/);

      globalThis.fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ content: string }>;
        };
        assert.equal(body.model, config.llm.consolidateModel);
        assert.match(
          body.messages[0].content,
          /does not make clinical/i,
        );
        assert.match(body.messages[1].content, /Unsupported claim/);
        return Promise.resolve(Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                findings: [{
                  kind: "data_gap",
                  severity: "info",
                  summary: "The claim has no source provenance.",
                  page_ids: [noteId],
                  recommendation: "Add a relevant primary source.",
                }],
              }),
            },
          }],
        }));
      };
      const analysisResponse = await handle(
        new Request("http://localhost/api/lint/analyze", {
          method: "POST",
          headers: mutationHeaders(),
          body: "{}",
        }),
      );
      assert.equal(analysisResponse.status, 200);
      const analysis = await analysisResponse.json();
      assert.deepEqual(analysis.findings[0].pageIds, [noteId]);
      assert.doesNotMatch(JSON.stringify(analysis), /ollama/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

routeTest(
  "the local knowledge base remains usable without a provider",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db, dir) => {
        await Deno.mkdir(`${dir}/notes`, { recursive: true });
        const sourceHash = "a".repeat(64);
        const sourceId = db.sources.addSource(
          sourceHash,
          "Local evidence",
          "https://example.test/local-evidence",
          "text",
          `${dir}/sources/${sourceHash}/source.txt`,
          "Evidence retained in the local vault.",
        );
        const firstPath = `${dir}/notes/local-mechanism.md`;
        const secondPath = `${dir}/notes/local-observation.md`;
        await Deno.writeTextFile(
          firstPath,
          renderWikiPage({
            title: "Local mechanism",
            type: "concept",
            body: "A locally reviewed mechanism links to an observation.",
            tags: ["offline"],
            links: ["Local observation"],
          }, [{ title: "Local evidence", contentHash: sourceHash }]),
        );
        await Deno.writeTextFile(
          secondPath,
          renderWikiPage({
            title: "Local observation",
            type: "concept",
            body: "A locally reviewed observation.",
            tags: ["offline"],
            links: [],
          }, [{ title: "Local evidence", contentHash: sourceHash }]),
        );
        const firstId = db.notes.addNote(
          "Local mechanism",
          firstPath,
          "https://example.test/local-evidence",
          "text",
        );
        const secondId = db.notes.addNote(
          "Local observation",
          secondPath,
          "https://example.test/local-evidence",
          "text",
        );
        db.sources.attachNoteSource(firstId, sourceId, "new");
        db.sources.attachNoteSource(secondId, sourceId, "new");
        db.notes.indexNote(
          firstId,
          "Local mechanism",
          "A locally reviewed mechanism links to an observation.",
        );
        db.notes.indexNote(
          secondId,
          "Local observation",
          "A locally reviewed observation.",
        );

        globalThis.fetch = () => {
          throw new Error("offline knowledge routes must not use fetch");
        };
        const handle = createHandler(db, () => {
          throw new Error(
            "offline knowledge routes must not resolve providers",
          );
        });

        const requests = [
          "/api/notes",
          `/api/notes/${firstId}`,
          "/api/sources",
          `/api/sources/${sourceId}`,
          "/api/graph",
          "/api/search?q=mechanism",
          "/api/search?q=What%20is%20mechanism%3F&mode=keyword",
          "/api/search?q=local&mode=keyword",
          "/api/lint",
        ];
        const responses = await Promise.all(
          requests.map((path) =>
            handle(new Request(`http://localhost${path}`))
          ),
        );
        assert.deepEqual(
          responses.map((response) => response.status),
          requests.map(() => 200),
        );
        const graph = await responses[4].json();
        assert.deepEqual(graph.links, [{
          source: firstId,
          target: secondId,
          kind: "explicit",
        }]);
        const searches = await Promise.all(
          responses.slice(5, 8).map((response) => response.json()),
        ) as Array<{
          results: Array<{
            id: number;
            matchType: string;
            score: number;
          }>;
        }>;
        for (const search of searches.slice(0, 2)) {
          assert.equal(search.results[0].id, firstId);
          assert.equal(search.results[0].matchType, "keyword");
        }
        assert.equal(searches[2].results[0].matchType, "keyword");
        assert.ok(searches[2].results.length >= 2);
        assert.ok(
          searches[2].results.every((result, index, results) =>
            index === 0 || results[index - 1].score >= result.score
          ),
        );
        const lint = await responses[8].json();
        assert.equal(lint.pageCount, 2);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "provider readiness is lightweight and fails safely into knowledge-only mode",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db) => {
        const providers = {
          source: "environment" as const,
          llm: {
            apiBase: config.llm.apiBase,
            apiKey: config.llm.apiKey,
            extractModel: config.llm.extractModel,
            consolidateModel: config.llm.consolidateModel,
            integrateModel: config.llm.integrateModel,
            rewriteModel: config.llm.rewriteModel,
          },
          embedding: {
            apiBase: config.embed.apiBase,
            apiKey: config.embed.apiKey,
            model: config.embed.model,
          },
        };
        const handle = createHandler(db, () => Promise.resolve(providers));
        const models = [
          ...new Set([
            providers.llm.extractModel,
            providers.llm.consolidateModel,
            providers.llm.integrateModel,
            providers.llm.rewriteModel,
            providers.embedding.model,
          ]),
        ].map((id) => ({ id }));
        let calls = 0;
        globalThis.fetch = (input, init) => {
          calls++;
          assert.match(String(input), /\/models$/);
          assert.equal(init?.method, undefined);
          assert.equal(init?.body, undefined);
          return Promise.resolve(Response.json({ data: models }));
        };

        const available = await handle(
          new Request("http://localhost/api/provider/readiness"),
        );
        assert.equal(available.status, 200);
        const availableBody = await available.json();
        assert.equal(availableBody.readiness.ready, true);
        assert.equal(availableBody.readiness.mode, "local");
        assert.equal(availableBody.semanticIndex.complete, false);
        assert.equal(availableBody.semanticIndex.compatible, false);
        assert.equal("identity" in availableBody.semanticIndex, false);
        assert.doesNotMatch(
          JSON.stringify(availableBody.semanticIndex),
          /apiBase|embedModel|embedding_identity/,
        );
        assert.equal(calls, 1);

        globalThis.fetch = () =>
          Promise.reject(new Error("private provider transport detail"));
        const unavailable = await handle(
          new Request("http://localhost/api/provider/readiness"),
        );
        assert.equal(unavailable.status, 503);
        const unavailableBody = await unavailable.json();
        assert.equal(unavailableBody.code, "PROVIDER_UNAVAILABLE");
        assert.match(unavailableBody.error, /keyword search remain available/);
        assert.doesNotMatch(
          JSON.stringify(unavailableBody),
          /private provider transport detail/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "provider settings are tested, stored, and returned redacted",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db) => {
        let storedProfile: unknown = null;
        const secrets = new Map<string, string>();
        const settings = {
          profiles: {
            load: () => Promise.resolve(storedProfile as never),
            save: (value: unknown) => {
              storedProfile = value;
              return Promise.resolve(value as never);
            },
          },
          secrets: {
            get: (name: "llm" | "embedding") =>
              Promise.resolve(secrets.get(name) ?? null),
            set: (name: "llm" | "embedding", value: string) => {
              secrets.set(name, value);
              return Promise.resolve();
            },
            delete: (name: "llm" | "embedding") => {
              secrets.delete(name);
              return Promise.resolve();
            },
          },
        };
        const handle = createHandler(
          db,
          () =>
            Promise.resolve({
              source: "environment",
              llm: {
                apiBase: config.llm.apiBase,
                apiKey: config.llm.apiKey,
                extractModel: config.llm.extractModel,
                consolidateModel: config.llm.consolidateModel,
                integrateModel: config.llm.integrateModel,
                rewriteModel: config.llm.rewriteModel,
              },
              embedding: {
                apiBase: config.embed.apiBase,
                apiKey: config.embed.apiKey,
                model: config.embed.model,
              },
            }),
          settings,
        );

        const before = await handle(
          new Request("http://localhost/api/provider"),
        );
        assert.deepEqual(await before.json(), {
          configured: true,
          profile: null,
          llmKeyStored: false,
          embeddingKeyStored: false,
          source: "environment",
          mode: "local",
          embeddingDimensions: config.embed.dimensions,
        });

        let diagnosticCalls = 0;
        globalThis.fetch = (input) => {
          diagnosticCalls++;
          if (String(input).endsWith("/chat/completions")) {
            return Promise.resolve(Response.json({
              choices: [{
                finish_reason: "stop",
                message: { content: '{"ok":true}' },
              }],
            }));
          }
          return Promise.resolve(Response.json({
            data: [
              config.llm.extractModel,
              config.llm.consolidateModel,
              config.llm.integrateModel,
              config.llm.rewriteModel,
            ].map((id) => ({ id })),
          }));
        };
        const diagnostics = await handle(
          new Request("http://localhost/api/provider/diagnose", {
            method: "POST",
            headers: mutationHeaders(),
            body: "{}",
          }),
        );
        const diagnosticsBody = await diagnostics.json();
        assert.equal(diagnosticsBody.diagnostics.mode, "local");
        assert.equal(diagnosticsBody.diagnostics.ready, false);
        assert.deepEqual(
          diagnosticsBody.diagnostics.embedding.missingModels,
          [config.embed.model],
        );
        assert.equal(diagnosticsBody.diagnostics.chat.probe.ok, true);
        assert.equal(
          diagnosticsBody.diagnostics.embedding.probe.attempted,
          false,
        );
        assert.equal(diagnosticCalls, 2);
        assert.doesNotMatch(JSON.stringify(diagnosticsBody), /secret/);

        globalThis.fetch = () =>
          Promise.reject(new Error("private local transport detail"));
        const failedDiagnostics = await handle(
          new Request("http://localhost/api/provider/diagnose", {
            method: "POST",
            headers: mutationHeaders(),
            body: "{}",
          }),
        );
        assert.equal(failedDiagnostics.status, 502);
        const failedDiagnosticsBody = await failedDiagnostics.json();
        assert.equal(
          failedDiagnosticsBody.code,
          "PROVIDER_UNAVAILABLE",
        );
        assert.match(failedDiagnosticsBody.error, /Start Ollama/);
        assert.doesNotMatch(
          JSON.stringify(failedDiagnosticsBody),
          /private local transport detail/,
        );

        const profile = {
          id: "default",
          displayName: "Research provider",
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
        const connectionChecks: string[] = [];
        globalThis.fetch = (input) => {
          const url = String(input);
          connectionChecks.push(url);
          if (url.endsWith("/models")) {
            return Promise.resolve(Response.json({
              data: [{
                id: url.startsWith(profile.embedding.apiBase)
                  ? profile.embedding.model
                  : profile.llm.model,
              }],
            }));
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
            return Promise.resolve(Response.json({
              data: [{
                embedding: Array(config.embed.dimensions).fill(0),
              }],
            }));
          }
          throw new Error(`Unexpected provider request: ${url}`);
        };
        const configured = await handle(
          new Request("http://localhost/api/provider", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({
              profile,
              llmApiKey: "llm-secret",
              embeddingApiKey: "embedding-secret",
            }),
          }),
        );
        assert.equal(configured.status, 200);
        const configuredBody = await configured.json();
        assert.equal(configuredBody.configured, true);
        assert.doesNotMatch(
          JSON.stringify(configuredBody),
          /llm-secret|embedding-secret/,
        );
        assert.deepEqual(connectionChecks.sort(), [
          "https://embed.example.test/v1/embeddings",
          "https://embed.example.test/v1/models",
          "https://llm.example.test/v1/chat/completions",
          "https://llm.example.test/v1/models",
        ]);
        assert.equal(secrets.get("llm"), "llm-secret");
        assert.equal(secrets.get("embedding"), "embedding-secret");
        assert.doesNotMatch(
          JSON.stringify(storedProfile),
          /llm-secret|embedding-secret/,
        );

        const after = await handle(
          new Request("http://localhost/api/provider"),
        );
        const afterBody = await after.json();
        assert.equal(afterBody.configured, true);
        assert.equal(afterBody.mode, "remote");
        assert.equal(afterBody.llmKeyStored, true);
        assert.equal(afterBody.embeddingKeyStored, true);

        const fetchesBeforeInvalid = connectionChecks.length;
        const invalid = await handle(
          new Request("http://localhost/api/provider", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({
              profile: {
                ...profile,
                llm: { ...profile.llm, apiBase: "http://remote.example/v1" },
              },
              llmApiKey: "llm-secret",
              embeddingApiKey: "embedding-secret",
            }),
          }),
        );
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, "INVALID_INPUT");
        assert.equal(connectionChecks.length, fetchesBeforeInvalid);

        globalThis.fetch = (input) => {
          connectionChecks.push(String(input));
          return Promise.reject(new Error("private transport detail"));
        };
        const unavailable = await handle(
          new Request("http://localhost/api/provider", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({
              profile: { ...profile, displayName: "Unavailable provider" },
              llmApiKey: "replacement-llm-secret",
              embeddingApiKey: "replacement-embedding-secret",
            }),
          }),
        );
        assert.equal(unavailable.status, 502);
        const unavailableBody = await unavailable.json();
        assert.equal(
          unavailableBody.code,
          "PROVIDER_CONFIGURATION_FAILED",
        );
        assert.equal(unavailableBody.error, "Unable to contact provider");
        assert.doesNotMatch(
          JSON.stringify(unavailableBody),
          /private transport detail|replacement-llm-secret/,
        );
        assert.equal(secrets.get("llm"), "llm-secret");
        assert.equal(secrets.get("embedding"), "embedding-secret");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "semantic search uses the resolved provider without exposing its key",
  async () => {
    const originalFetch = globalThis.fetch;
    const originalSearchLimit = config.security.semanticSearchesPerMinute;
    try {
      config.security.semanticSearchesPerMinute = 1;
      await withTempHandler(async (_defaultHandler, db) => {
        const embeddingProvider = {
          apiBase: "https://embed.example.test/v1",
          model: "embed",
        };
        const noteId = db.notes.addNote("Stored note", "note.md", null, "text");
        db.notes.indexNote(noteId, "Stored note", "Searchable content");
        db.search.activateSemanticIndex(embeddingIdentity(embeddingProvider));
        db.search.upsertEmbedding(
          noteId,
          Array.from(
            { length: config.embed.dimensions },
            (_, index) => index === 0 ? 1 : 0,
          ),
        );
        const relatedId = db.notes.addNote(
          "Related note",
          "related.md",
          null,
          "text",
        );
        db.notes.indexNote(
          relatedId,
          "Related note",
          "Related searchable content",
        );
        db.search.upsertEmbedding(relatedId, [
          0.5,
          Math.sqrt(0.75),
          ...Array<number>(config.embed.dimensions - 2).fill(0),
        ]);
        let resolveCalls = 0;
        globalThis.fetch = (input, init) => {
          assert.equal(input, "https://embed.example.test/v1/embeddings");
          assert.deepEqual(init?.headers, {
            "Content-Type": "application/json",
            Authorization: "Bearer embedding-secret",
          });
          return Promise.resolve(Response.json({
            data: [{
              embedding: Array.from(
                { length: config.embed.dimensions },
                (_, index) => index === 0 ? 1 : 0,
              ),
            }],
          }));
        };
        const handle = createHandler(db, () => {
          resolveCalls++;
          return Promise.resolve({
            source: "profile",
            llm: {
              apiBase: "https://llm.example.test/v1",
              apiKey: "llm-secret",
              extractModel: "chat",
              consolidateModel: "chat",
              integrateModel: "chat",
              rewriteModel: "chat",
            },
            embedding: {
              apiBase: embeddingProvider.apiBase,
              apiKey: "embedding-secret",
              model: embeddingProvider.model,
            },
          });
        });
        const response = await handle(
          new Request("http://localhost/api/search?q=stored&mode=semantic"),
        );
        assert.equal(response.status, 200);
        assert.equal(resolveCalls, 1);
        const text = await response.text();
        assert.doesNotMatch(text, /embedding-secret|llm-secret/);
        const body = JSON.parse(text);
        assert.deepEqual(
          body.results.map((result: { id: number }) => result.id),
          [noteId, relatedId],
        );
        assert.ok(body.results[0].score > body.results[1].score);
        const limited = await handle(
          new Request("http://localhost/api/search?q=stored&mode=semantic"),
        );
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).code, "RATE_LIMITED");
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.security.semanticSearchesPerMinute = originalSearchLimit;
    }
  },
);

routeTest(
  "wiki query returns citations and saves reviewed synthesis",
  async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    try {
      await withTempHandler(async (_defaultHandler, db, dir) => {
        config.vaultDir = dir;
        await Deno.mkdir(`${dir}/notes`, { recursive: true });
        const sourceHash = "e".repeat(64);
        const sourceId = db.sources.addSource(
          sourceHash,
          "Controlled study",
          "https://example.test/study",
          "text",
          `${dir}/sources/${sourceHash}/source.txt`,
          "Study summary.",
        );
        const notePath = `${dir}/notes/treatment-effect.md`;
        await Deno.writeTextFile(
          notePath,
          "# Treatment effect\n\nThe evidence is mixed.\n",
        );
        const noteId = db.notes.addNote(
          "Treatment effect",
          notePath,
          "https://example.test/study",
          "text",
        );
        db.notes.indexNote(
          noteId,
          "Treatment effect",
          "The evidence is mixed.",
        );
        db.sources.attachNoteSource(noteId, sourceId, "new");
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        db.search.activateSemanticIndex(embeddingIdentity({
          apiBase: "https://embed.example.test/v1",
          model: "embed",
        }));
        db.search.upsertEmbedding(noteId, embedding);

        const requests: Array<{ url: string; body: Record<string, unknown> }> =
          [];
        globalThis.fetch = (input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          const index = requests.push({ url: String(input), body }) - 1;
          if (index === 0 || index === 2) {
            return Promise.resolve(Response.json({ data: [{ embedding }] }));
          }
          if (index === 1) {
            return Promise.resolve(Response.json({
              choices: [{
                message: {
                  content: JSON.stringify({
                    answer: "The available evidence is mixed.",
                    citations: [noteId],
                    suggested_page: {
                      title: "Treatment evidence synthesis",
                      tags: ["treatment", "evidence"],
                    },
                  }),
                },
              }],
            }));
          }
          throw new Error(`Unexpected provider request ${index + 1}`);
        };
        const providers = () =>
          Promise.resolve({
            source: "profile" as const,
            llm: {
              apiBase: "https://llm.example.test/v1",
              apiKey: "llm-secret",
              extractModel: "chat",
              consolidateModel: "synthesis-model",
              integrateModel: "chat",
              rewriteModel: "chat",
            },
            embedding: {
              apiBase: "https://embed.example.test/v1",
              apiKey: "embedding-secret",
              model: "embed",
            },
          });
        const handle = createHandler(db, providers);
        const question = "What does the treatment evidence show?";
        const queryResponse = await handle(
          new Request("http://localhost/api/query", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({ question }),
          }),
        );
        assert.equal(queryResponse.status, 200);
        const answer = await queryResponse.json();
        assert.deepEqual(answer.citations, [{
          id: noteId,
          title: "Treatment effect",
        }]);
        assert.equal(Object.hasOwn(answer.citations[0], "file_path"), false);
        assert.equal(answer.answer, "The available evidence is mixed.");
        const queryMessages = requests[1].body.messages as Array<{
          content: string;
        }>;
        assert.match(
          queryMessages[0].content,
          /does not make clinical/i,
        );

        const saveBody = {
          question,
          answer: answer.answer,
          citations: answer.citations.map((citation: { id: number }) =>
            citation.id
          ),
          suggestedPage: answer.suggestedPage,
        };
        const saveResponse = await handle(
          new Request("http://localhost/api/query/save", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(saveBody),
          }),
        );
        assert.equal(saveResponse.status, 201);
        const saved = await saveResponse.json();
        assert.equal(saved.saved.title, "Treatment evidence synthesis");
        assert.equal(requests.length, 3);
        assert.equal(
          requests[0].url,
          "https://embed.example.test/v1/embeddings",
        );
        assert.equal(
          requests[1].url,
          "https://llm.example.test/v1/chat/completions",
        );
        assert.equal(
          requests[2].url,
          "https://embed.example.test/v1/embeddings",
        );
        assert.doesNotMatch(
          JSON.stringify(answer),
          /llm-secret|embedding-secret/,
        );

        const duplicate = await handle(
          new Request("http://localhost/api/query/save", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(saveBody),
          }),
        );
        assert.equal(duplicate.status, 409);
        assert.equal((await duplicate.json()).code, "PAGE_EXISTS");
        assert.equal(requests.length, 3);

        let malformedCalls = 0;
        globalThis.fetch = () => {
          malformedCalls++;
          return Promise.resolve(
            malformedCalls === 1
              ? Response.json({ data: [{ embedding }] })
              : Response.json({ choices: [] }),
          );
        };
        const providerFailure = await handle(
          new Request("http://localhost/api/query", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({ question }),
          }),
        );
        assert.equal(providerFailure.status, 502);
        const providerError = await providerFailure.json();
        assert.equal(providerError.code, "LLM_SERVICE_ERROR");
        assert.doesNotMatch(
          JSON.stringify(providerError),
          /llm-secret|embedding-secret/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
    }
  },
);

routeTest(
  "wiki query uses keywords and explicit links when semantic index is incomplete",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (handle, db, dir) => {
        const seedPath = `${dir}/seed.md`;
        const neighbourPath = `${dir}/neighbour.md`;
        const seedPage = renderWikiPage({
          title: "Mechanism evidence",
          type: "concept",
          body: "A kinase mechanism is reported in the source.",
          tags: ["mechanism"],
          links: ["Related assay"],
        }, []);
        const neighbourPage = renderWikiPage({
          title: "Related assay",
          type: "entity",
          body: "The assay measures a downstream response.",
          tags: ["assay"],
          links: [],
        }, []);
        await Deno.writeTextFile(seedPath, seedPage);
        await Deno.writeTextFile(neighbourPath, neighbourPage);
        const seedId = db.notes.addNote(
          "Mechanism evidence",
          seedPath,
          null,
          "text",
        );
        const neighbourId = db.notes.addNote(
          "Related assay",
          neighbourPath,
          null,
          "text",
        );
        db.notes.indexNote(
          seedId,
          "Mechanism evidence",
          "A kinase mechanism is reported.",
        );
        db.notes.indexNote(
          neighbourId,
          "Related assay",
          "A downstream response assay.",
        );

        let fetchCalls = 0;
        let suppliedPages: Array<{ id: number }> = [];
        globalThis.fetch = (_input, init) => {
          fetchCalls++;
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ content: string }>;
          };
          const request = JSON.parse(body.messages[1].content) as {
            pages: Array<{ id: number }>;
          };
          suppliedPages = request.pages;
          return Promise.resolve(Response.json({
            choices: [{
              message: {
                content: JSON.stringify({
                  answer: "The mechanism is connected to its response assay.",
                  citations: [seedId, neighbourId],
                  suggested_page: {
                    title: "Mechanism and assay synthesis",
                    tags: ["mechanism"],
                  },
                }),
              },
            }],
          }));
        };

        const response = await handle(
          new Request("http://localhost/api/query", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({
              question: "What kinase mechanism is reported?",
            }),
          }),
        );
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(
          result.citations.map((item: { id: number }) => item.id),
          [
            seedId,
            neighbourId,
          ],
        );
        assert.deepEqual(suppliedPages.map((page) => page.id), [
          seedId,
          neighbourId,
        ]);
        assert.equal(fetchCalls, 1);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "invalid mutation origin is rejected before reading the body",
  async () => {
    await withTempHandler(async (handle) => {
      const response = await handle(
        new Request("http://localhost/api/ingest", {
          method: "POST",
          headers: mutationHeaders("https://attacker.example"),
        }),
      );

      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "INVALID_ORIGIN");
    });
  },
);

routeTest(
  "oversized JSON is rejected for a valid origin and content type",
  async () => {
    await withTempHandler(async (handle) => {
      const headers = new Headers(mutationHeaders());
      headers.set("Content-Length", String(config.security.maxBodyBytes + 1));
      const response = await handle(
        new Request("http://localhost/api/ingest", {
          method: "POST",
          headers,
          body: "{}",
        }),
      );

      assert.equal(response.status, 413);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      assert.equal((await response.json()).code, "INPUT_TOO_LARGE");
    });
  },
);

routeTest(
  "SSE ingestion exposes safe LLM errors without persisting partial state",
  async () => {
    const originalFetch = globalThis.fetch;
    const originalSecurity = {
      trustProxyAuth: config.security.trustProxyAuth,
      publicOrigin: config.security.publicOrigin,
      allowedEmails: config.security.allowedEmails,
      ingesterEmails: config.security.ingesterEmails,
    };
    try {
      config.security.trustProxyAuth = true;
      config.security.publicOrigin = "https://synthesis.example";
      config.security.allowedEmails = ["llm-error@example.com"];
      config.security.ingesterEmails = ["llm-error@example.com"];
      await withTempHandler(async (handle, db) => {
        globalThis.fetch = () => Promise.resolve(new Response(""));

        const response = await handle(
          new Request("https://synthesis.example/api/ingest", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "llm-error@example.com",
            },
            body: JSON.stringify({
              title: "Invalid provider response",
              text: "A source that must not be persisted after failure.",
            }),
          }),
        );

        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("Content-Type") ?? "",
          /^text\/event-stream/,
        );
        const events = await response.text();
        assert.match(events, /"stage":"error"/);
        assert.match(events, /"code":"LLM_SERVICE_ERROR"/);
        assert.match(
          events,
          /"error":"LLM service returned an invalid JSON response"/,
        );
        assert.deepEqual(db.sources.getAllSources(), []);
        assert.deepEqual(db.proposals.getIngestProposals(), []);
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.security.trustProxyAuth = originalSecurity.trustProxyAuth;
      config.security.publicOrigin = originalSecurity.publicOrigin;
      config.security.allowedEmails = originalSecurity.allowedEmails;
      config.security.ingesterEmails = originalSecurity.ingesterEmails;
    }
  },
);

routeTest(
  "local file uploads are bounded and stage reviewed changes",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (handle, db) => {
        let fetchCalls = 0;
        globalThis.fetch = () => {
          fetchCalls++;
          return Promise.resolve(Response.json({
            choices: [{
              message: {
                content: JSON.stringify(
                  fetchCalls === 1
                    ? {
                      items: [{
                        title: "Uploaded finding",
                        type: "concept",
                        body: "A finding from a local Markdown file.",
                        tags: ["upload"],
                        links: [],
                      }],
                    }
                    : {
                      summary: "A local Markdown source.",
                      notes: [{
                        title: "Uploaded finding",
                        type: "concept",
                        body: "A finding from a local Markdown file.",
                        tags: ["upload"],
                        links: [],
                      }],
                    },
                ),
              },
            }],
          }));
        };

        const form = new FormData();
        form.set(
          "file",
          new File(
            ["# Local report\n\nA source-backed finding."],
            "local-report.md",
            { type: "text/markdown" },
          ),
        );
        form.set("title", "Reviewed local report");
        const response = await handle(
          new Request("http://localhost/api/ingest/file", {
            method: "POST",
            headers: { Origin: "http://localhost" },
            body: form,
          }),
        );
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("Content-Type") ?? "",
          /^text\/event-stream/,
        );
        const events = await response.text();
        assert.match(events, /"stage":"proposal"/);
        assert.match(events, /"sourceType":"markdown"/);
        assert.equal(fetchCalls, 2);
        assert.deepEqual(db.notes.getAllNotes(), []);
        assert.equal(db.sources.getAllSources()[0].source_type, "markdown");

        const wrongType = await handle(
          new Request("http://localhost/api/ingest/file", {
            method: "POST",
            headers: mutationHeaders(),
            body: "{}",
          }),
        );
        assert.equal(wrongType.status, 415);
        assert.equal((await wrongType.json()).code, "INVALID_CONTENT_TYPE");

        const oversized = await handle(
          new Request("http://localhost/api/ingest/file", {
            method: "POST",
            headers: {
              Origin: "http://localhost",
              "Content-Type": "multipart/form-data; boundary=upload",
              "Content-Length": String(config.security.maxUploadBytes + 1),
            },
            body: "x",
          }),
        );
        assert.equal(oversized.status, 413);
        assert.equal((await oversized.json()).code, "INPUT_TOO_LARGE");

        const invalidForm = new FormData();
        invalidForm.set(
          "file",
          new File(["Valid text"], "source.txt", { type: "text/plain" }),
        );
        invalidForm.set("unexpected", "field");
        const invalid = await handle(
          new Request("http://localhost/api/ingest/file", {
            method: "POST",
            headers: { Origin: "http://localhost" },
            body: invalidForm,
          }),
        );
        assert.equal(invalid.status, 200);
        const invalidEvents = await invalid.text();
        assert.match(invalidEvents, /"stage":"error"/);
        assert.match(invalidEvents, /"code":"INVALID_INPUT"/);
        assert.equal(fetchCalls, 2);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "YouTube inputs are validated and playlists can be disabled",
  async () => {
    await withTempHandler(async (handle) => {
      assert.equal(config.ingest.playlistEnabled, true);

      const invalidVideo = await handle(
        new Request("http://localhost/api/ingest", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ url: "not-a-video-id" }),
        }),
      );
      assert.equal(invalidVideo.status, 400);
      assert.equal((await invalidVideo.json()).code, "INVALID_YOUTUBE_INPUT");

      const invalidPlaylist = await handle(
        new Request("http://localhost/api/ingest/playlist", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          }),
        }),
      );
      assert.equal(invalidPlaylist.status, 400);
      assert.equal(
        (await invalidPlaylist.json()).code,
        "INVALID_YOUTUBE_INPUT",
      );

      const originalPlaylistEnabled = config.ingest.playlistEnabled;
      try {
        config.ingest.playlistEnabled = false;
        const disabled = await handle(
          new Request("http://localhost/api/ingest/playlist", {
            method: "POST",
            headers: mutationHeaders(),
          }),
        );
        assert.equal(disabled.status, 404);
        assert.equal((await disabled.json()).code, "NOT_FOUND");
      } finally {
        config.ingest.playlistEnabled = originalPlaylistEnabled;
      }
    });
  },
);

routeTest(
  "trusted batches require exact automatic-apply confirmation",
  async () => {
    await withTempHandler(async (handle) => {
      const request = (body: Record<string, unknown>) =>
        handle(
          new Request("http://localhost/api/ingest/batch", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(body),
          }),
        );

      const unconfirmed = await request({
        urls: ["dQw4w9WgXcQ"],
        reviewMode: "automatic",
      });
      assert.equal(unconfirmed.status, 400);
      assert.equal((await unconfirmed.json()).code, "CONFIRMATION_REQUIRED");

      const duplicate = await request({
        urls: ["dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"],
        reviewMode: "automatic",
        confirm: "AUTO APPLY 2 TRUSTED SOURCES",
      });
      assert.equal(duplicate.status, 400);
      assert.equal((await duplicate.json()).code, "INVALID_TRUSTED_BATCH");
    });
  },
);

routeTest(
  "cancelling a trusted batch stream stops before the next safe boundary",
  async () => {
    await withTempHandler(async (_defaultHandle, db) => {
      let resolveProviders!: (
        providers: ReturnType<typeof environmentProviders>,
      ) => void;
      let markProviderRequested!: () => void;
      const providerRequested = new Promise<void>((resolve) => {
        markProviderRequested = resolve;
      });
      const providers = new Promise<ReturnType<typeof environmentProviders>>(
        (resolve) => {
          resolveProviders = resolve;
        },
      );
      let ingestCalls = 0;
      const handle = createHandler(
        db,
        () => {
          markProviderRequested();
          return providers;
        },
        undefined,
        {
          ingestYouTube: () => {
            ingestCalls++;
            throw new Error("Cancelled batch must not begin its first source");
          },
        },
      );

      const response = await handle(
        new Request("http://localhost/api/ingest/batch", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            urls: ["dQw4w9WgXcQ"],
            reviewMode: "automatic",
            confirm: "AUTO APPLY 1 TRUSTED SOURCES",
          }),
        }),
      );
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /"stage":"ingesting"/,
      );
      await providerRequested;
      await reader.cancel();
      resolveProviders(environmentProviders());
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(ingestCalls, 0);
    });
  },
);

routeTest(
  "trusted batches stage, validate, apply, and audit each source",
  async () => {
    const originalFetch = globalThis.fetch;
    const originalAuth = {
      trustProxyAuth: config.security.trustProxyAuth,
      publicOrigin: config.security.publicOrigin,
      allowedEmails: config.security.allowedEmails,
      ingesterEmails: config.security.ingesterEmails,
    };
    try {
      config.security.trustProxyAuth = true;
      config.security.publicOrigin = "https://synthesis.example";
      config.security.allowedEmails = ["trusted-batch@example.com"];
      config.security.ingesterEmails = ["trusted-batch@example.com"];
      await withTempHandler(async (_handle, db, dir) => {
        await Deno.mkdir(`${dir}/notes`, { recursive: true });
        await Deno.mkdir(`${dir}/sources`, { recursive: true });
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        let requests = 0;
        globalThis.fetch = () => {
          switch (requests++) {
            case 0:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      items: [{
                        title: "Automatically reviewed concept",
                        type: "concept",
                        body: "A bounded claim from a trusted source.",
                        tags: ["trusted-batch"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 1:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      summary: "A trusted source summary.",
                      notes: [{
                        title: "Automatically reviewed concept",
                        type: "concept",
                        body: "A bounded claim from a trusted source.",
                        tags: ["trusted-batch"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 2:
              return Promise.resolve(Response.json({
                data: [{ embedding }],
              }));
            default:
              return Promise.resolve(Response.json({
                choices: [{
                  message: { content: JSON.stringify({ discoveries: [] }) },
                }],
              }));
          }
        };
        const ingestVideo = (url: string) =>
          Promise.resolve({
            transcript: "A curated transcript for automatic ingestion.",
            sourceUrl: url,
            title: "Trusted video",
            sourceType: "youtube" as const,
          });
        const handle = createHandler(db, undefined, undefined, {
          ingestYouTube: ingestVideo,
        });

        const response = await handle(
          new Request("https://synthesis.example/api/ingest/batch", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "trusted-batch@example.com",
            },
            body: JSON.stringify({
              urls: ["dQw4w9WgXcQ"],
              reviewMode: "automatic",
              confirm: "AUTO APPLY 1 TRUSTED SOURCES",
            }),
          }),
        );
        assert.equal(response.status, 200);
        const events = await response.text();
        assert.match(events, /"stage":"batch_started"/);
        assert.match(events, /"stage":"automatic_proposal"/);
        assert.match(events, /"stage":"automatic_applied"/);
        assert.match(events, /"stage":"synthesizing"/);
        assert.match(events, /"stage":"batch_complete"/);
        assert.match(events, /"stage":"done"/);
        assert.equal(db.notes.getAllNotes().length, 1);

        const historyEntries = [...Deno.readDirSync(`${dir}/history`)];
        assert.equal(historyEntries.length, 1);
        const history = await readIngestHistoryManifest(
          `${dir}/history/${historyEntries[0].name}`,
        );
        assert.equal(history.reviewMode, "automatic");
        assert.match(history.batchId ?? "", /^[0-9a-f-]{36}$/i);
        assert.equal(
          db.proposals.getIngestProposal(history.proposalId)?.status,
          "approved",
        );

        const resumed = await handle(
          new Request("https://synthesis.example/api/ingest/batch", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "trusted-batch@example.com",
            },
            body: JSON.stringify({
              urls: ["dQw4w9WgXcQ"],
              reviewMode: "automatic",
              confirm: "AUTO APPLY 1 TRUSTED SOURCES",
            }),
          }),
        );
        assert.equal(resumed.status, 200);
        const resumedEvents = await resumed.text();
        assert.match(resumedEvents, /"stage":"batch_skipped"/);
        assert.doesNotMatch(resumedEvents, /"stage":"automatic_proposal"/);
        assert.doesNotMatch(resumedEvents, /"stage":"automatic_applied"/);
        assert.equal(db.notes.getAllNotes().length, 1);
        assert.equal([...Deno.readDirSync(`${dir}/history`)].length, 1);
        assert.equal(requests, 3);
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.security.trustProxyAuth = originalAuth.trustProxyAuth;
      config.security.publicOrigin = originalAuth.publicOrigin;
      config.security.allowedEmails = originalAuth.allowedEmails;
      config.security.ingesterEmails = originalAuth.ingesterEmails;
    }
  },
);

routeTest(
  "note detail renders only a sanitized body without exposing file paths",
  async () => {
    await withTempHandler(async (handle, db, dir) => {
      const filePath = `${dir}/private-note.md`;
      const sourceHash = "f".repeat(64);
      await Deno.writeTextFile(
        filePath,
        renderWikiPage({
          title: "Private note",
          type: "concept",
          body: [
            "Body with **strong evidence** and [a safe link](https://example.com).",
            "",
            "- First finding",
            "- Second finding",
            "",
            "<script>alert('unsafe')</script>",
          ].join("\n"),
          tags: ["provenance"],
          links: [],
        }, [{
          title: "Private source",
          contentHash: sourceHash,
          pages: [2, 4],
        }]),
      );
      const sourceId = db.sources.addSource(
        sourceHash,
        "Private source",
        null,
        "pdf",
        `${dir}/private-source.txt`,
        "Evidence summary.",
      );
      const noteId = db.notes.addNote(
        "Private note",
        filePath,
        "https://youtube.com/watch?v=source",
        "youtube",
      );
      db.sources.attachNoteSource(noteId, sourceId, "merge");

      const response = await handle(
        new Request(`http://localhost/api/notes/${noteId}`),
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.match(payload.content, /# Private note/);
      assert.match(payload.bodyHtml, /<strong>strong evidence<\/strong>/);
      assert.match(payload.bodyHtml, /href="https:\/\/example\.com"/);
      assert.match(payload.bodyHtml, /<li>First finding<\/li>/);
      assert.doesNotMatch(payload.bodyHtml, /<script|alert\('unsafe'\)/i);
      assert.doesNotMatch(
        payload.bodyHtml,
        /Private source|SHA-256|synthesis-source/,
      );
      assert.deepEqual(payload.sources, [{
        id: sourceId,
        title: "Private source",
        sourceUrl: null,
        sourceType: "pdf",
        summary: "Evidence summary.",
        action: "merge",
        sourcePages: [2, 4],
      }]);
      assert.deepEqual(payload.claims, [{
        text:
          "Body with **strong evidence** and [a safe link](https://example.com).",
        sourceIds: [sourceId],
      }, {
        text: "- First finding\n- Second finding",
        sourceIds: [sourceId],
      }, {
        text: "<script>alert('unsafe')</script>",
        sourceIds: [sourceId],
      }]);
      assert.equal(Object.hasOwn(payload, "file_path"), false);
      assert.equal(Object.hasOwn(payload.sources[0], "filePath"), false);
      assert.equal(Object.hasOwn(payload.sources[0], "contentHash"), false);
      assert.doesNotMatch(
        JSON.stringify({ sources: payload.sources, claims: payload.claims }),
        /private-source\.txt|[a-f0-9]{64}/,
      );
    });
  },
);

routeTest("graph and related pages prefer explicit wiki links", async () => {
  await withTempHandler(async (handle, db, dir) => {
    const addPage = async (title: string, links: string[]) => {
      const path = `${dir}/${title.toLowerCase()}.md`;
      await Deno.writeTextFile(
        path,
        renderWikiPage({
          title,
          type: "concept",
          body: `Knowledge about ${title}.`,
          tags: ["graph"],
          links,
        }, []),
      );
      return db.notes.addNote(title, path, null, "text");
    };
    const first = await addPage("First", ["Second"]);
    const second = await addPage("Second", []);
    const third = await addPage("Third", []);
    db.search.upsertLink(first, second, 0.99);
    db.search.upsertLink(second, third, 0.8);

    const graphResponse = await handle(
      new Request("http://localhost/api/graph"),
    );
    const graph = await graphResponse.json();
    assert.deepEqual(graph.links, [
      { source: first, target: second, kind: "explicit" },
      {
        source: second,
        target: third,
        kind: "semantic",
        similarity: 0.8,
      },
    ]);

    const noteResponse = await handle(
      new Request(`http://localhost/api/notes/${second}`),
    );
    const note = await noteResponse.json();
    assert.deepEqual(note.related, [
      { id: first, title: "First", kind: "explicit" },
      { id: third, title: "Third", kind: "semantic", similarity: 0.8 },
    ]);
  });
});

routeTest("discoveries are reviewed and confirmed as wiki links", async () => {
  await withTempHandler(async (handle, db, dir) => {
    const sourceHash = "d".repeat(64);
    const sourceId = db.sources.addSource(
      sourceHash,
      "Discovery evidence",
      "https://example.test/discovery",
      "text",
      `${dir}/discovery-source.txt`,
      "Evidence supporting review of a possible connection.",
    );
    const addPage = async (title: string) => {
      const path = `${dir}/${title.toLowerCase()}.md`;
      const page = {
        title,
        type: "concept" as const,
        body: `Evidence for ${title}.`,
        tags: ["discovery"],
        links: [],
      };
      await Deno.writeTextFile(
        path,
        renderWikiPage(page, [{
          title: "Discovery evidence",
          contentHash: sourceHash,
        }]),
      );
      const id = db.notes.addNote(title, path, null, "text");
      db.sources.attachNoteSource(id, sourceId, "new");
      return {
        id,
        evidenceHash: await discoveryEvidenceHash(page, [sourceId]),
      };
    };
    const firstPage = await addPage("Discovery alpha");
    const secondPage = await addPage("Discovery beta");
    const first = firstPage.id;
    const second = secondPage.id;
    const discoveryId = db.discoveries.addDiscovery({
      fingerprint: `mechanistic|${first},${second}|${sourceId}`,
      relationship_type: "mechanistic",
      explanation: "The pages may describe connected mechanisms.",
      significance: "The connection may focus further evidence review.",
      page_ids_json: JSON.stringify([first, second]),
      page_hashes_json: JSON.stringify([
        firstPage.evidenceHash,
        secondPage.evidenceHash,
      ]),
      source_ids_json: JSON.stringify([sourceId]),
      production_method: "llm_graph_review",
      model: "review-model",
      confidence: 0.7,
    });
    assert.ok(discoveryId);

    const list = await handle(
      new Request("http://localhost/api/discoveries"),
    ).then((response) => response.json());
    assert.equal(list.discoveries[0].id, discoveryId);
    assert.equal(list.discoveries[0].pages.length, 2);
    assert.equal(list.discoveries[0].sources[0].id, sourceId);

    const detail = await handle(
      new Request(`http://localhost/api/discoveries/${discoveryId}`),
    ).then((response) => response.json());
    assert.equal(detail.discovery.relationshipType, "mechanistic");
    assert.equal(detail.discovery.proposalKind, "relationship");

    const investigate = await handle(
      new Request(
        `http://localhost/api/discoveries/${discoveryId}/investigate`,
        { method: "POST", headers: mutationHeaders(), body: "{}" },
      ),
    );
    assert.equal((await investigate.json()).discovery.status, "investigating");

    const confirm = await handle(
      new Request(
        `http://localhost/api/discoveries/${discoveryId}/confirm`,
        { method: "POST", headers: mutationHeaders(), body: "{}" },
      ),
    );
    assert.equal((await confirm.json()).discovery.status, "confirmed");
    const graph = await handle(
      new Request("http://localhost/api/graph"),
    ).then((response) => response.json());
    assert.equal(graph.links.length, 1);
    assert.equal(graph.links[0].source, first);
    assert.equal(graph.links[0].target, second);
    assert.equal(graph.links[0].kind, "explicit");
    assert.equal(graph.links[0].relationships[0].type, "mechanistic");

    const terminal = await handle(
      new Request(
        `http://localhost/api/discoveries/${discoveryId}/reject`,
        { method: "POST", headers: mutationHeaders(), body: "{}" },
      ),
    );
    assert.equal(terminal.status, 409);
    assert.equal(
      (await terminal.json()).code,
      "DISCOVERY_NOT_REVIEWABLE",
    );

    const missing = await handle(
      new Request("http://localhost/api/discoveries/99999"),
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "DISCOVERY_NOT_FOUND");

    const invalidScan = await handle(
      new Request("http://localhost/api/discoveries/generate", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ pageIds: [] }),
      }),
    );
    assert.equal(invalidScan.status, 400);
    assert.equal((await invalidScan.json()).code, "INVALID_INPUT");
    const invalidGeneration = await handle(
      new Request("http://localhost/api/discoveries/generate", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ generation: "not-a-generation" }),
      }),
    );
    assert.equal(invalidGeneration.status, 400);
    assert.equal((await invalidGeneration.json()).code, "INVALID_INPUT");

    const otherHash = "e".repeat(64);
    const otherSourceId = db.sources.addSource(
      otherHash,
      "Independent conference talk",
      "https://example.test/other-talk",
      "youtube",
      `${dir}/other-source.txt`,
      "A separate talk with potentially related evidence.",
    );
    const otherPath = `${dir}/discovery-gamma.md`;
    await Deno.writeTextFile(
      otherPath,
      renderWikiPage({
        title: "Discovery gamma",
        type: "concept",
        body: "Evidence for a related mechanism from another talk.",
        tags: ["discovery"],
        links: [],
      }, [{ title: "Independent conference talk", contentHash: otherHash }]),
    );
    const otherPageId = db.notes.addNote(
      "Discovery gamma",
      otherPath,
      null,
      "youtube",
    );
    db.sources.attachNoteSource(otherPageId, otherSourceId, "new");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
        };
        const payload = JSON.parse(request.messages.at(-1)!.content) as {
          candidates: Array<{ candidate_index: number }>;
        };
        assert.ok(payload.candidates.length > 0);
        return Promise.resolve(Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                discoveries: [{
                  candidate_index: payload.candidates[0].candidate_index,
                  relationship_type: "analogous",
                  explanation:
                    "The separate talks describe comparable mechanisms.",
                  significance:
                    "The comparison may reveal a reusable conference theme.",
                  confidence: 0.66,
                }],
              }),
            },
          }],
        }));
      };
      const scan = await handle(
        new Request("http://localhost/api/discoveries/generate", {
          method: "POST",
          headers: mutationHeaders(),
          body: "{}",
        }),
      );
      assert.equal(scan.status, 200);
      const generated = await scan.json();
      assert.equal(generated.discoveries.length, 1);
      assert.equal(generated.discoveries[0].proposalKind, "relationship");
      assert.equal(generated.discoveries[0].sources.length, 2);
      assert.equal(generated.coverage.candidates, 2);
      assert.equal(generated.coverage.evaluated, 2);
      assert.equal(generated.coverage.proposed, 1);
      assert.equal(generated.coverage.remaining, 0);
      assert.equal(generated.coverage.complete, true);
      assert.match(generated.coverage.generation, /^[0-9a-f-]{36}$/i);

      const generatedId = generated.discoveries[0].id;
      const unconfirmedBatch = await handle(
        new Request("http://localhost/api/discoveries/batch", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            action: "confirm",
            ids: [generatedId],
            confirm: "CONFIRM ALL",
          }),
        }),
      );
      assert.equal(unconfirmedBatch.status, 400);
      assert.equal(
        (await unconfirmedBatch.json()).code,
        "CONFIRMATION_REQUIRED",
      );

      const confirmedBatch = await handle(
        new Request("http://localhost/api/discoveries/batch", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            action: "confirm",
            ids: [generatedId],
            confirm: "CONFIRM 1 LINKS",
          }),
        }),
      );
      assert.equal(confirmedBatch.status, 200);
      const confirmedBatchBody = await confirmedBatch.json();
      assert.equal(confirmedBatchBody.linksAdded, 1);
      assert.equal(confirmedBatchBody.reviewed[0].status, "confirmed");

      const rejectId = db.discoveries.addDiscovery({
        fingerprint:
          `research-gap|${first},${otherPageId}|${sourceId},${otherSourceId}`,
        relationship_type: "research_gap",
        explanation: "The supplied pages leave an open research question.",
        significance: "The gap may guide further evidence collection.",
        page_ids_json: JSON.stringify([first, otherPageId]),
        page_hashes_json: JSON.stringify([
          firstPage.evidenceHash,
          "f".repeat(64),
        ]),
        source_ids_json: JSON.stringify([sourceId, otherSourceId]),
        production_method: "test",
        model: "test-model",
        confidence: 0.6,
      });
      assert.ok(rejectId);
      const rejectedBatch = await handle(
        new Request("http://localhost/api/discoveries/batch", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            action: "reject",
            ids: [rejectId],
            confirm: "REJECT 1 PROPOSALS",
          }),
        }),
      );
      assert.equal(rejectedBatch.status, 200);
      assert.equal((await rejectedBatch.json()).reviewed[0].status, "rejected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

routeTest(
  "source review exposes provenance without internal paths",
  async () => {
    await withTempHandler(async (handle, db, dir) => {
      const sourceHash = "f".repeat(64);
      const sourceId = db.sources.addSource(
        sourceHash,
        "Randomized clinical trial",
        "https://example.test/trial",
        "text",
        `${dir}/sources/private/source.txt`,
        "A controlled comparison of two interventions.",
      );
      const notePath = `${dir}/notes/treatment-comparison.md`;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      await Deno.writeTextFile(
        notePath,
        renderWikiPage({
          title: "Treatment comparison",
          type: "concept",
          body: "A controlled comparison.",
          tags: ["evidence"],
          links: [],
        }, [{
          title: "Randomized clinical trial",
          url: "https://example.test/trial",
          contentHash: sourceHash,
          pages: [9, 4],
        }]),
      );
      const noteId = db.notes.addNote(
        "Treatment comparison",
        notePath,
        "https://example.test/trial",
        "text",
      );
      db.sources.attachNoteSource(noteId, sourceId, "new");

      const listResponse = await handle(
        new Request("http://localhost/api/sources"),
      );
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json();
      assert.equal(list.sources[0].pageCount, 1);
      assert.equal(list.sources[0].title, "Randomized clinical trial");

      const detailResponse = await handle(
        new Request(`http://localhost/api/sources/${sourceId}`),
      );
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      assert.deepEqual(detail.pages, [{
        id: noteId,
        title: "Treatment comparison",
        action: "new",
        sourcePages: [4, 9],
      }]);
      assert.doesNotMatch(
        JSON.stringify({ list, detail }),
        new RegExp(`${sourceHash}|source\\.txt|treatment-comparison\\.md`),
      );

      const missing = await handle(
        new Request("http://localhost/api/sources/99999"),
      );
      assert.equal(missing.status, 404);
    });
  },
);

routeTest(
  "ingest proposals are listed, approved, rejected, and guarded",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (handle, db, dir) => {
        await Deno.mkdir(`${dir}/notes`, { recursive: true });
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        let fetchCalls = 0;
        globalThis.fetch = () => {
          switch (fetchCalls++) {
            case 0:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      items: [{
                        title: "Approved proposal page",
                        type: "concept",
                        body: "Reviewed knowledge.",
                        tags: ["review"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 1:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      summary: "Approved proposal summary.",
                      notes: [{
                        title: "Approved proposal page",
                        type: "concept",
                        body: "Reviewed knowledge.",
                        tags: ["review"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 2:
              return Promise.resolve(Response.json({
                data: [{ embedding }],
              }));
            case 3:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      items: [{
                        title: "Rejected proposal page",
                        type: "concept",
                        body: "Unaccepted knowledge.",
                        tags: ["review"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 4:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      summary: "Rejected proposal summary.",
                      notes: [{
                        title: "Rejected proposal page",
                        type: "concept",
                        body: "Unaccepted knowledge.",
                        tags: ["review"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 5:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      decisions: [{ action: "new" }],
                    }),
                  },
                }],
              }));
            default:
              throw new Error(`Unexpected provider request ${fetchCalls}`);
          }
        };

        const ingest = async (title: string, text: string) => {
          const response = await handle(
            new Request("http://localhost/api/ingest", {
              method: "POST",
              headers: mutationHeaders(),
              body: JSON.stringify({ title, text }),
            }),
          );
          assert.equal(response.status, 200);
          assert.match(await response.text(), /"stage":"proposal"/);
        };

        await ingest("Approved source", "Source text for approval.");
        assert.deepEqual(db.notes.getAllNotes(), []);
        const pendingResponse = await handle(
          new Request("http://localhost/api/proposals"),
        );
        const pending = await pendingResponse.json();
        assert.equal(pending.proposals.length, 1);
        const approvedId = pending.proposals[0].id;
        assert.equal(pending.proposals[0].status, "pending");

        const detailResponse = await handle(
          new Request(`http://localhost/api/proposals/${approvedId}`),
        );
        const detail = await detailResponse.json();
        assert.equal(detail.proposal.changes[0].action, "new");
        assert.equal(
          detail.proposal.changes[0].page.title,
          "Approved proposal page",
        );

        for (const body of [undefined, JSON.stringify({})]) {
          const unreviewedApproval = await handle(
            new Request(
              `http://localhost/api/proposals/${approvedId}/approve`,
              {
                method: "POST",
                headers: mutationHeaders(),
                ...(body === undefined ? {} : { body }),
              },
            ),
          );
          assert.equal(unreviewedApproval.status, 400);
          assert.equal(
            (await unreviewedApproval.json()).code,
            "INVALID_PROPOSAL_APPROVAL",
          );
          assert.equal(
            db.proposals.getIngestProposal(approvedId)?.status,
            "pending",
          );
        }

        const invalidApproval = await handle(
          new Request(
            `http://localhost/api/proposals/${approvedId}/approve`,
            {
              method: "POST",
              headers: mutationHeaders(),
              body: JSON.stringify({ changes: [{ index: 1 }] }),
            },
          ),
        );
        assert.equal(invalidApproval.status, 400);
        assert.equal(
          (await invalidApproval.json()).code,
          "INVALID_PROPOSAL_APPROVAL",
        );
        assert.equal(fetchCalls, 2);
        assert.equal(
          db.proposals.getIngestProposal(approvedId)?.status,
          "pending",
        );

        const approveResponse = await handle(
          new Request(
            `http://localhost/api/proposals/${approvedId}/approve`,
            {
              method: "POST",
              headers: mutationHeaders(),
              body: JSON.stringify({
                changes: [{
                  index: 0,
                  body: "Reviewed knowledge with approved wording.",
                }],
              }),
            },
          ),
        );
        assert.equal(approveResponse.status, 200);
        assert.match(await approveResponse.text(), /"stage":"done"/);
        assert.equal(db.notes.getAllNotes().length, 1);
        assert.equal(
          parseWikiPage(
            await Deno.readTextFile(db.notes.getAllNotes()[0].file_path),
          ).body,
          "Reviewed knowledge with approved wording.",
        );
        assert.equal(
          db.proposals.getIngestProposal(approvedId)?.status,
          "approved",
        );

        const terminalResponse = await handle(
          new Request(
            `http://localhost/api/proposals/${approvedId}/reject`,
            { method: "POST", headers: mutationHeaders(), body: "{}" },
          ),
        );
        assert.equal(terminalResponse.status, 409);
        assert.equal(
          (await terminalResponse.json()).code,
          "PROPOSAL_NOT_PENDING",
        );

        await ingest("Rejected source", "Source text for rejection.");
        const pendingAfterSecond = await handle(
          new Request("http://localhost/api/proposals"),
        ).then((response) => response.json());
        assert.equal(pendingAfterSecond.proposals.length, 1);
        const rejectedId = pendingAfterSecond.proposals[0].id;
        const rejectResponse = await handle(
          new Request(
            `http://localhost/api/proposals/${rejectedId}/reject`,
            { method: "POST", headers: mutationHeaders(), body: "{}" },
          ),
        );
        assert.equal(rejectResponse.status, 200);
        assert.equal((await rejectResponse.json()).proposal.status, "rejected");
        assert.equal(db.notes.getAllNotes().length, 1);

        const missingResponse = await handle(
          new Request("http://localhost/api/proposals/99999"),
        );
        assert.equal(missingResponse.status, 404);
        assert.equal(
          (await missingResponse.json()).code,
          "PROPOSAL_NOT_FOUND",
        );
        assert.equal(fetchCalls, 6);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

routeTest(
  "trusted proxy authentication enforces viewer and ingester roles",
  async () => {
    const original = {
      trustProxyAuth: config.security.trustProxyAuth,
      publicOrigin: config.security.publicOrigin,
      allowedEmails: config.security.allowedEmails,
      ingesterEmails: config.security.ingesterEmails,
    };

    try {
      config.security.trustProxyAuth = true;
      config.security.publicOrigin = "https://synthesis.example";
      config.security.allowedEmails = [
        "viewer@example.com",
        "editor@example.com",
      ];
      config.security.ingesterEmails = ["editor@example.com"];

      await withTempHandler(async (handle) => {
        const missing = await handle(
          new Request("https://synthesis.example/api/status"),
        );
        assert.equal(missing.status, 401);
        assert.equal((await missing.json()).code, "UNAUTHENTICATED");

        const unknown = await handle(
          new Request("https://synthesis.example/api/status", {
            headers: {
              "Cf-Access-Authenticated-User-Email": "unknown@example.com",
            },
          }),
        );
        assert.equal(unknown.status, 403);
        assert.equal((await unknown.json()).code, "FORBIDDEN");

        const viewer = await handle(
          new Request("https://synthesis.example/api/status", {
            headers: {
              "Cf-Access-Authenticated-User-Email": "viewer@example.com",
            },
          }),
        );
        assert.equal(viewer.status, 200);
        assert.deepEqual(await viewer.json(), { status: "ok" });

        const viewerIngest = await handle(
          new Request("https://synthesis.example/api/ingest", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "viewer@example.com",
            },
          }),
        );
        assert.equal(viewerIngest.status, 403);
        assert.equal((await viewerIngest.json()).code, "FORBIDDEN");

        const viewerSave = await handle(
          new Request("https://synthesis.example/api/query/save", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "viewer@example.com",
            },
          }),
        );
        assert.equal(viewerSave.status, 403);
        assert.equal((await viewerSave.json()).code, "FORBIDDEN");

        const ingester = await handle(
          new Request("https://synthesis.example/api/ingest", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": "editor@example.com",
            },
          }),
        );
        assert.equal(ingester.status, 400);
        assert.equal((await ingester.json()).code, "INVALID_JSON");
      });
    } finally {
      config.security.trustProxyAuth = original.trustProxyAuth;
      config.security.publicOrigin = original.publicOrigin;
      config.security.allowedEmails = original.allowedEmails;
      config.security.ingesterEmails = original.ingesterEmails;
    }
  },
);

routeTest(
  "SSE ingestion serialises identities and enforces queue and quota limits",
  async () => {
    const originalFetch = globalThis.fetch;
    const original = {
      vaultDir: config.vaultDir,
      trustProxyAuth: config.security.trustProxyAuth,
      publicOrigin: config.security.publicOrigin,
      allowedEmails: config.security.allowedEmails,
      ingesterEmails: config.security.ingesterEmails,
      ingestQueueSize: config.security.ingestQueueSize,
      perUserDailyJobs: config.security.perUserDailyJobs,
      globalDailyJobs: config.security.globalDailyJobs,
    };
    let resolveExtraction: ((response: Response) => void) | undefined;
    const extraction = new Promise<Response>((resolve) => {
      resolveExtraction = resolve;
    });
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    try {
      config.security.trustProxyAuth = true;
      config.security.publicOrigin = "https://synthesis.example";
      config.security.allowedEmails = [
        "first@example.com",
        "second@example.com",
        "third@example.com",
      ];
      config.security.ingesterEmails = [...config.security.allowedEmails];
      config.security.ingestQueueSize = 1;
      config.security.perUserDailyJobs = 1;
      config.security.globalDailyJobs = 10;

      await withTempHandler(async (handle, db, dir) => {
        config.vaultDir = dir;
        await Deno.mkdir(`${dir}/notes`, { recursive: true });

        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        const modelRequests: Array<{ url: string; model: unknown }> = [];
        let fetchCalls = 0;
        globalThis.fetch = (input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          modelRequests.push({ url: String(input), model: body.model });
          if (fetchCalls === 0) markFetchStarted?.();
          switch (fetchCalls++) {
            case 0:
              return extraction;
            case 1:
              return Promise.resolve(Response.json({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      summary: "Queued source summary.",
                      notes: [{
                        title: "Queued note",
                        type: "concept",
                        body: "Only one note is created.",
                        tags: ["queue"],
                        links: [],
                      }],
                    }),
                  },
                }],
              }));
            case 2:
              return Promise.resolve(Response.json({ data: [{ embedding }] }));
            default:
              throw new Error("unexpected concurrent or duplicate AI request");
          }
        };

        const ingestRequest = (email: string): Request =>
          new Request("https://synthesis.example/api/ingest", {
            method: "POST",
            headers: {
              ...mutationHeaders("https://synthesis.example"),
              "Cf-Access-Authenticated-User-Email": email,
            },
            body: JSON.stringify({
              title: "Queued source",
              text: "The same source text is submitted by both users.",
            }),
          });

        let firstResponse: Response | undefined;
        let secondResponse: Response | undefined;
        let secondPromise: Promise<Response> | undefined;
        try {
          firstResponse = await handle(ingestRequest("first@example.com"));
          assert.equal(firstResponse.status, 200);
          assert.match(
            firstResponse.headers.get("Content-Type") ?? "",
            /^text\/event-stream/,
          );
          await fetchStarted;
          assert.equal(fetchCalls, 1, "the first extraction must be held");

          const duplicate = await handle(ingestRequest("first@example.com"));
          assert.equal(duplicate.status, 429);
          assert.equal(duplicate.headers.get("Retry-After"), "30");
          assert.equal((await duplicate.json()).code, "BUSY");

          let secondResolved = false;
          secondPromise = handle(ingestRequest("second@example.com"));
          void secondPromise.then(() => {
            secondResolved = true;
          });
          await Promise.resolve();
          assert.equal(secondResolved, false, "the second identity must queue");
          assert.equal(fetchCalls, 1, "queued work must not call the model");

          const queueFull = await handle(ingestRequest("third@example.com"));
          assert.equal(queueFull.status, 429);
          assert.equal(queueFull.headers.get("Retry-After"), "30");
          assert.equal((await queueFull.json()).code, "BUSY");

          resolveExtraction?.(Response.json({
            choices: [{
              message: {
                content: JSON.stringify({
                  items: [{
                    title: "Queued note",
                    type: "concept",
                    body: "Only one note is created.",
                    tags: ["queue"],
                    links: [],
                  }],
                }),
              },
            }],
          }));
          const firstEvents = await firstResponse.text();
          assert.match(firstEvents, /"stage":"done"/);

          secondResponse = await secondPromise;
          assert.equal(secondResponse.status, 200);
          const secondEvents = await secondResponse.text();
          assert.match(secondEvents, /"stage":"proposal"/);
          assert.match(secondEvents, /"stage":"done"/);
          assert.equal(
            fetchCalls,
            2,
            "idempotent queued work must not call AI",
          );
          assert.equal(db.notes.getAllNotes().length, 0);

          const quota = await handle(ingestRequest("first@example.com"));
          assert.equal(quota.status, 429);
          assert.equal(quota.headers.get("Retry-After"), "3600");
          assert.equal((await quota.json()).code, "QUOTA_EXCEEDED");
          assert.deepEqual(modelRequests, [
            {
              url: `${config.llm.apiBase}/chat/completions`,
              model: config.llm.extractModel,
            },
            {
              url: `${config.llm.apiBase}/chat/completions`,
              model: config.llm.consolidateModel,
            },
          ]);
        } finally {
          resolveExtraction?.(Response.json({
            choices: [{ message: { content: JSON.stringify({ items: [] }) } }],
          }));
          if (firstResponse && !firstResponse.bodyUsed) {
            await firstResponse.text().catch(() => undefined);
          }
          if (secondPromise) {
            secondResponse ??= await secondPromise.catch(() => undefined);
            if (secondResponse && !secondResponse.bodyUsed) {
              await secondResponse.text().catch(() => undefined);
            }
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = original.vaultDir;
      config.security.trustProxyAuth = original.trustProxyAuth;
      config.security.publicOrigin = original.publicOrigin;
      config.security.allowedEmails = original.allowedEmails;
      config.security.ingesterEmails = original.ingesterEmails;
      config.security.ingestQueueSize = original.ingestQueueSize;
      config.security.perUserDailyJobs = original.perUserDailyJobs;
      config.security.globalDailyJobs = original.globalDailyJobs;
    }
  },
);

routeTest(
  "semantic index rebuild requires confirmation and resumes bounded work",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempHandler(async (_defaultHandler, db, dir) => {
        for (let index = 0; index < 2; index++) {
          const path = `${dir}/semantic-${index + 1}.md`;
          await Deno.writeTextFile(
            path,
            renderWikiPage({
              title: `Semantic page ${index + 1}`,
              type: "concept",
              body: `Semantically related evidence ${index + 1}.`,
              tags: ["semantic"],
              links: [],
            }, []),
          );
          db.notes.addNote(`Semantic page ${index + 1}`, path, null, "text");
        }
        const providers = {
          source: "profile" as const,
          llm: {
            apiBase: "https://llm.example.test/v1",
            apiKey: "llm-secret",
            extractModel: "chat",
            consolidateModel: "chat",
            integrateModel: "chat",
            rewriteModel: "chat",
          },
          embedding: {
            apiBase: "https://embed.example.test/v1",
            apiKey: "embedding-secret",
            model: "embed",
          },
        };
        globalThis.fetch = () =>
          Promise.resolve(Response.json({
            data: [{
              embedding: [
                1,
                0.25,
                ...Array<number>(config.embed.dimensions - 2).fill(0),
              ],
            }],
          }));
        const handle = createHandler(db, () => Promise.resolve(providers));

        const unconfirmed = await handle(
          new Request("http://localhost/api/semantic-index/rebuild", {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({ confirm: "REBUILD", limit: 1 }),
          }),
        );
        assert.equal(unconfirmed.status, 400);
        assert.equal((await unconfirmed.json()).code, "CONFIRMATION_REQUIRED");

        const run = async () => {
          const response = await handle(
            new Request("http://localhost/api/semantic-index/rebuild", {
              method: "POST",
              headers: mutationHeaders(),
              body: JSON.stringify({
                confirm: "REBUILD SEMANTIC INDEX",
                limit: 1,
              }),
            }),
          );
          assert.equal(response.status, 200);
          return (await response.json()).semanticIndex;
        };
        const first = await run();
        assert.equal(first.processed, 1);
        assert.equal(first.complete, false);
        assert.equal(first.remaining, 1);
        const second = await run();
        assert.equal(second.complete, true);
        assert.equal(second.links, 1);

        const status = await handle(
          new Request("http://localhost/api/semantic-index"),
        ).then((response) => response.json());
        assert.equal(status.semanticIndex.complete, true);
        assert.equal("identity" in status.semanticIndex, false);
        assert.equal("expectedIdentity" in status.semanticIndex, false);
        assert.doesNotMatch(
          JSON.stringify(status),
          /embedding-secret|llm-secret|embed\.example\.test/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
