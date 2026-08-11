import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import { createHandler } from "./routes.ts";

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
  try {
    await test(createHandler(db), db, dir);
  } finally {
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

routeTest("wiki lint is read-only and provider-independent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withTempHandler(async (handle, db, dir) => {
      const filePath = `${dir}/legacy.md`;
      await Deno.writeTextFile(
        filePath,
        "# Legacy page\n\nUnsupported claim.\n",
      );
      const noteId = db.addNote("Legacy page", filePath, null, "text");
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
          configured: false,
          profile: null,
          llmKeyStored: false,
          embeddingKeyStored: false,
          source: "profile",
          embeddingDimensions: config.embed.dimensions,
        });

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
    try {
      await withTempHandler(async (_defaultHandler, db) => {
        const noteId = db.addNote("Stored note", "note.md", null, "text");
        db.indexNote(noteId, "Stored note", "Searchable content");
        db.upsertEmbedding(
          noteId,
          Array.from(
            { length: config.embed.dimensions },
            (_, index) => index === 0 ? 1 : 0,
          ),
        );
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
              apiBase: "https://embed.example.test/v1",
              apiKey: "embedding-secret",
              model: "embed",
            },
          });
        });
        const response = await handle(
          new Request("http://localhost/api/search?q=stored&mode=semantic"),
        );
        assert.equal(response.status, 200);
        assert.equal(resolveCalls, 1);
        assert.doesNotMatch(
          await response.text(),
          /embedding-secret|llm-secret/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
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
        const sourceId = db.addSource(
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
        const noteId = db.addNote(
          "Treatment effect",
          notePath,
          "https://example.test/study",
          "text",
        );
        db.indexNote(noteId, "Treatment effect", "The evidence is mixed.");
        db.attachNoteSource(noteId, sourceId, "new");
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        db.upsertEmbedding(noteId, embedding);

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
                      type: "synthesis",
                      body: "The available evidence is mixed.",
                      tags: ["treatment", "evidence"],
                      links: ["Treatment effect"],
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
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
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

routeTest("playlist ingestion is hidden while disabled", async () => {
  const original = config.ingest.playlistEnabled;
  try {
    config.ingest.playlistEnabled = false;
    await withTempHandler(async (handle) => {
      const response = await handle(
        new Request("http://localhost/api/ingest/playlist", {
          method: "POST",
          headers: mutationHeaders(),
        }),
      );

      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "NOT_FOUND");
    });
  } finally {
    config.ingest.playlistEnabled = original;
  }
});

routeTest(
  "note detail returns content without exposing its file path",
  async () => {
    await withTempHandler(async (handle, db, dir) => {
      const filePath = `${dir}/private-note.md`;
      await Deno.writeTextFile(filePath, "# Private note\n\nBody text.\n");
      const noteId = db.addNote(
        "Private note",
        filePath,
        "https://youtube.com/watch?v=source",
        "youtube",
      );

      const response = await handle(
        new Request(`http://localhost/api/notes/${noteId}`),
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.content, "# Private note\n\nBody text.\n");
      assert.equal(Object.hasOwn(payload, "file_path"), false);
    });
  },
);

routeTest(
  "source review exposes provenance without internal paths",
  async () => {
    await withTempHandler(async (handle, db, dir) => {
      const sourceId = db.addSource(
        "private-content-hash",
        "Randomized clinical trial",
        "https://example.test/trial",
        "text",
        `${dir}/sources/private/source.txt`,
        "A controlled comparison of two interventions.",
      );
      const noteId = db.addNote(
        "Treatment comparison",
        `${dir}/notes/treatment-comparison.md`,
        "https://example.test/trial",
        "text",
      );
      db.attachNoteSource(noteId, sourceId, "new");

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
      }]);
      assert.doesNotMatch(
        JSON.stringify({ list, detail }),
        /private-content-hash|source\.txt|treatment-comparison\.md/,
      );

      const missing = await handle(
        new Request("http://localhost/api/sources/99999"),
      );
      assert.equal(missing.status, 404);
    });
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
  "SSE ingestion serializes identities and enforces queue and quota limits",
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
          assert.match(secondEvents, /"stage":"source_exists"/);
          assert.match(secondEvents, /"stage":"done"/);
          assert.equal(
            fetchCalls,
            3,
            "idempotent queued work must not call AI",
          );
          assert.equal(db.getAllNotes().length, 1);

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
            {
              url: `${config.embed.apiBase}/embeddings`,
              model: config.embed.model,
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
