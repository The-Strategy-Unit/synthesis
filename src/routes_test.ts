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
  await withTempHandler(async (handle) => {
    assert.equal(config.ingest.playlistEnabled, false);
    const response = await handle(
      new Request("http://localhost/api/ingest/playlist", {
        method: "POST",
        headers: mutationHeaders(),
      }),
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
  });
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
          { length: 4096 },
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
