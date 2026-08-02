import assert from "node:assert/strict";

import { config } from "./config.ts";
import { distil, type DistilNote, integrate } from "./distil.ts";

function chatResponse(content: string): Response {
  return Response.json({
    choices: [{ message: { content } }],
  });
}

Deno.test("LLM output is validated before integration or consolidation", async () => {
  const originalFetch = globalThis.fetch;
  const newNotes: DistilNote[] = [{
    title: "New evidence",
    body: "The new source refines an existing claim.",
    tags: ["evidence"],
  }];
  const existingNotes = [{
    id: 7,
    title: "Existing claim",
    body: "The original claim.",
  }];
  const apiBase = "http://stub.invalid/v1";

  try {
    globalThis.fetch = () =>
      Promise.resolve(chatResponse(
        JSON.stringify({
          decisions: [{ action: "merge", existing_id: 7 }],
        }),
      ));
    assert.deepEqual(
      await integrate(
        newNotes,
        existingNotes,
        apiBase,
        "test-key",
        "test-model",
      ),
      [{ action: "merge", existing_id: 7 }],
    );

    globalThis.fetch = () =>
      Promise.resolve(chatResponse(
        JSON.stringify({ decisions: [{ action: "replace" }] }),
      ));
    await assert.rejects(
      integrate(
        newNotes,
        existingNotes,
        apiBase,
        "test-key",
        "test-model",
      ),
      /action is invalid/,
    );

    globalThis.fetch = () =>
      Promise.resolve(chatResponse(JSON.stringify({ decisions: [] })));
    await assert.rejects(
      integrate(
        newNotes,
        existingNotes,
        apiBase,
        "test-key",
        "test-model",
      ),
      /returned 0 decisions; expected 1/,
    );

    globalThis.fetch = () =>
      Promise.resolve(chatResponse(
        JSON.stringify({
          decisions: [{ action: "contradict", existing_id: 999 }],
        }),
      ));
    await assert.rejects(
      integrate(
        newNotes,
        existingNotes,
        apiBase,
        "test-key",
        "test-model",
      ),
      /existing_id is not a supplied note ID/,
    );

    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse("not JSON"));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      SyntaxError,
    );
    assert.equal(fetchCalls, 1, "malformed extraction must not consolidate");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse(JSON.stringify({ items: [] })));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /items must contain 1-8 notes/,
    );
    assert.equal(fetchCalls, 1, "empty extraction must not consolidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("distil bounds extraction concurrency and preserves chunk order", async () => {
  const originalFetch = globalThis.fetch;
  const originalMaxChars = config.ingest.maxChars;
  const originalOverlap = config.ingest.overlap;
  const chunks = [
    "aaaaaaaaaa",
    "bbbbbbbbbb",
    "cccccccccc",
    "dddddddddd",
    "eeeeeeeeee",
  ];
  const deferred: Array<{
    chunk: string;
    settled: boolean;
    resolve: (response: Response) => void;
  }> = [];
  let active = 0;
  let peakActive = 0;
  let consolidationCandidates: Array<{ title: string; body: string }> = [];
  let resolveThree: (() => void) | undefined;
  let resolveFour: (() => void) | undefined;
  let resolveFive: (() => void) | undefined;
  const threeStarted = new Promise<void>((resolve) => resolveThree = resolve);
  const fourStarted = new Promise<void>((resolve) => resolveFour = resolve);
  const fiveStarted = new Promise<void>((resolve) => resolveFive = resolve);
  let run: Promise<unknown> | undefined;
  let runSettled = false;

  const release = (index: number): void => {
    const request = deferred[index];
    assert.ok(request, `extraction request ${index} has not started`);
    if (request.settled) return;
    request.settled = true;
    request.resolve(chatResponse(JSON.stringify({
      items: [{
        title: `Chunk ${request.chunk}`,
        body: `Body for ${request.chunk}`,
        tags: ["chunk"],
      }],
    })));
  };

  try {
    config.ingest.maxChars = 10;
    config.ingest.overlap = 0;
    globalThis.fetch = (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const systemPrompt = body.messages[0].content;
      if (systemPrompt.includes("knowledge extraction engine")) {
        const chunk = body.messages[1].content;
        active++;
        peakActive = Math.max(peakActive, active);
        let resolveResponse: ((response: Response) => void) | undefined;
        const response = new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }).finally(() => active--);
        assert.ok(resolveResponse);
        deferred.push({ chunk, settled: false, resolve: resolveResponse });
        if (deferred.length === 3) resolveThree?.();
        if (deferred.length === 4) resolveFour?.();
        if (deferred.length === 5) resolveFive?.();
        return response;
      }

      assert.match(systemPrompt, /knowledge synthesis expert/);
      const input = JSON.parse(body.messages[1].content) as {
        candidates: Array<{ title: string; body: string }>;
      };
      consolidationCandidates = input.candidates;
      return Promise.resolve(chatResponse(JSON.stringify({
        summary: "Five chunks were consolidated.",
        notes: [{
          title: "Ordered result",
          body: "The chunks remained ordered.",
          tags: ["order"],
        }],
      })));
    };

    run = distil(chunks.join(""), "http://stub.invalid/v1", "test-key");
    void run.then(
      () => runSettled = true,
      () => runSettled = true,
    );
    await threeStarted;
    assert.equal(deferred.length, 3);
    assert.equal(active, 3);
    assert.equal(peakActive, 3);
    await Promise.resolve();
    assert.equal(deferred.length, 3, "a fourth extraction must remain blocked");

    release(2);
    await fourStarted;
    assert.equal(peakActive, 3);
    release(0);
    await fiveStarted;
    assert.equal(peakActive, 3);

    release(4);
    release(1);
    release(3);
    const result = await run;
    assert.equal(peakActive, 3);
    assert.deepEqual(
      consolidationCandidates.map((candidate) => candidate.title),
      chunks.map((chunk) => `Chunk ${chunk}`),
      "out-of-order extraction completion must not reorder candidates",
    );
    assert.deepEqual(
      consolidationCandidates.map((candidate) => candidate.body),
      chunks.map((chunk) => `Body for ${chunk}`),
    );
    assert.equal(
      (result as { summary: string }).summary,
      "Five chunks were consolidated.",
    );

    let oversizedFetches = 0;
    globalThis.fetch = () => {
      oversizedFetches++;
      throw new Error("oversized input must not reach fetch");
    };
    await assert.rejects(
      distil("x".repeat(330), "http://stub.invalid/v1", "test-key"),
      /maximum is 32/,
    );
    assert.equal(oversizedFetches, 0);
  } finally {
    while (run && !runSettled) {
      for (let index = 0; index < deferred.length; index++) release(index);
      await Promise.resolve();
    }
    await run?.catch(() => undefined);
    globalThis.fetch = originalFetch;
    config.ingest.maxChars = originalMaxChars;
    config.ingest.overlap = originalOverlap;
  }
});
