import assert from "node:assert/strict";

import { config } from "./config.ts";
import { distil, type DistilNote, integrate, rewriteNote } from "./distil.ts";

function chatResponse(content: string): Response {
  return Response.json({
    choices: [{ message: { content } }],
  });
}

Deno.test("Ollama explicitly disables default reasoning", async () => {
  const originalFetch = globalThis.fetch;
  const originalReasoningEffort = config.llm.reasoningEffort;
  const requestBodies: Array<Record<string, unknown>> = [];
  const newNotes: DistilNote[] = [{
    title: "New evidence",
    type: "concept",
    body: "New evidence refines an existing claim.",
    tags: ["evidence"],
    links: [],
  }];
  const existingNotes = [{ id: 1, title: "Existing claim" }];

  try {
    config.llm.reasoningEffort = "none";
    globalThis.fetch = (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(chatResponse(JSON.stringify({
        decisions: [{ action: "merge", existing_id: 1 }],
      })));
    };

    await integrate(
      newNotes,
      existingNotes,
      "http://127.0.0.1:11434/v1",
      "ollama",
      "test-model",
    );
    await integrate(
      newNotes,
      existingNotes,
      "https://provider.example/v1",
      "test-key",
      "test-model",
    );

    assert.equal(requestBodies[0].reasoning_effort, "none");
    assert.equal("reasoning_effort" in requestBodies[1], false);
  } finally {
    globalThis.fetch = originalFetch;
    config.llm.reasoningEffort = originalReasoningEffort;
  }
});

Deno.test("LLM output is validated before integration or consolidation", async () => {
  const originalFetch = globalThis.fetch;
  const newNotes: DistilNote[] = [{
    title: "New evidence",
    type: "concept",
    body: "The new source refines an existing claim.",
    tags: ["evidence"],
    links: ["Existing claim"],
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
    const retryBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (_input, init) => {
      retryBodies.push(JSON.parse(String(init?.body)));
      fetchCalls++;
      return Promise.resolve(chatResponse(
        fetchCalls === 1 ? "not JSON" : JSON.stringify(
          fetchCalls === 2
            ? {
              items: [{
                title: "Recovered extraction",
                type: "concept",
                body: "The retry returned valid structured knowledge.",
                tags: ["retry"],
                source_pages: [1],
              }],
            }
            : {
              summary: "The extraction recovered after one retry.",
              notes: [{
                title: "Recovered extraction",
                type: "concept",
                body: "The retry returned valid structured knowledge.",
                tags: ["retry"],
                links: [],
                source_pages: [1],
              }],
            },
        ),
      ));
    };
    const recovered = await distil("Source text", apiBase, "test-key");
    assert.equal(recovered.notes.length, 1);
    assert.deepEqual(recovered.notes[0].links, []);
    assert.equal(recovered.notes[0].sourcePages, undefined);
    assert.equal(fetchCalls, 3);
    assert.equal(retryBodies[1].temperature, 0);
    assert.match(
      JSON.stringify(retryBodies[1].messages),
      /previous response failed validation/,
    );

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse("not JSON"));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /Extraction response was invalid after one retry: Extraction response was not valid JSON/,
    );
    assert.equal(fetchCalls, 2, "malformed extraction retries exactly once");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(new Response(""));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /LLM service returned an invalid JSON response/,
    );
    assert.equal(fetchCalls, 1, "invalid provider JSON must not consolidate");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(Response.json({
        choices: [{
          finish_reason: "length",
          message: { content: '{"items": [' },
        }],
      }));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /LLM response exceeded the output token limit/,
    );
    assert.equal(fetchCalls, 1, "truncated extraction must not consolidate");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse(""));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /LLM response content must not be empty/,
    );
    assert.equal(fetchCalls, 1, "empty model content must not consolidate");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse(JSON.stringify({ items: [] })));
    };
    await assert.rejects(
      distil("Source text", apiBase, "test-key"),
      /items must contain 1-8 notes/,
    );
    assert.equal(fetchCalls, 2, "empty extraction retries exactly once");

    fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse(JSON.stringify(
        fetchCalls === 1
          ? {
            items: [{
              title: "Supported claim",
              type: "concept",
              body: "The source supports a claim.",
              tags: ["evidence"],
              links: [],
            }],
          }
          : {
            summary: "The source supports a claim.",
            notes: [{
              title: "Supported claim",
              type: "concept",
              body: "The source supports a claim.",
              tags: ["evidence"],
              links: ["Missing page"],
            }],
          },
      )));
    };
    const withoutDanglingLinks = await distil(
      "Source text",
      apiBase,
      "test-key",
    );
    assert.deepEqual(withoutDanglingLinks.notes[0].links, []);
    assert.equal(
      fetchCalls,
      2,
      "dangling final links are removed without retrying",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration guards numeric corrections and near-duplicate pages", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  const correctedBody = `${
    "Audit context remains unchanged. ".repeat(9)
  }A corrected audit updates the median turnaround time to 6.5 days rather than 5 days.`;

  try {
    globalThis.fetch = (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Promise.resolve(chatResponse(JSON.stringify({
        decisions: [
          { action: "new" },
          { action: "merge", existing_id: 7 },
        ],
      })));
    };

    assert.deepEqual(
      await integrate(
        [{
          title: "Operational audit result",
          type: "concept",
          body: correctedBody,
          tags: ["audit"],
          links: [],
        }, {
          title: "Clinical escalation protocols",
          type: "concept",
          body: "The protocol adds a documented escalation contact.",
          tags: ["clinical"],
          links: [],
        }],
        [{
          id: 7,
          title: "Operational audit result",
          body: "The median turnaround time was 5 days.",
        }, {
          id: 8,
          title: "Clinical escalation protocol",
          body: "The protocol defines the escalation path.",
        }],
        "http://stub.invalid/v1",
        "test-key",
        "test-model",
      ),
      [
        { action: "contradict", existing_id: 7 },
        { action: "merge", existing_id: 8 },
      ],
    );

    const messages = requestBody?.messages as Array<{ content: string }>;
    const payload = JSON.parse(messages[1].content) as {
      new_notes: Array<{ body: string }>;
    };
    assert.ok(payload.new_notes[0].body.length > 200);
    assert.match(payload.new_notes[0].body, /6\.5 days rather than 5 days/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("distil permits candidate links before final consolidation", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = () => {
      fetchCalls++;
      return Promise.resolve(chatResponse(JSON.stringify(
        fetchCalls === 1
          ? {
            items: [{
              title: "Candidate page",
              type: "concept",
              body: "The source suggests a connection.",
              tags: ["connection"],
              links: ["related page"],
            }],
          }
          : {
            summary: "The source connects two concepts.",
            notes: [{
              title: "Candidate page",
              type: "concept",
              body: "The source suggests a connection.",
              tags: ["connection"],
              links: ["Related page"],
            }, {
              title: "Related page",
              type: "concept",
              body: "The related concept is grounded during consolidation.",
              tags: ["connection"],
              links: [],
            }],
          },
      )));
    };

    const result = await distil(
      "Source text",
      "http://stub.invalid/v1",
      "test-key",
    );
    assert.equal(result.notes.length, 2);
    assert.deepEqual(result.notes[0].links, ["Related page"]);
    assert.equal(
      fetchCalls,
      2,
      "valid candidate links must not trigger a retry",
    );
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
        type: "concept",
        body: `Body for ${request.chunk}`,
        tags: ["chunk"],
        links: [],
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
      if (systemPrompt.includes("compiling source material")) {
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

      assert.match(systemPrompt, /compiling candidate pages/);
      const input = JSON.parse(body.messages[1].content) as {
        candidates: Array<{ title: string; body: string }>;
      };
      consolidationCandidates = input.candidates;
      return Promise.resolve(chatResponse(JSON.stringify({
        summary: "Unsupported <script>alert('unsafe')</script> conclusion.",
        notes: [{
          title: "Ordered result",
          type: "synthesis",
          body: "The chunks remained ordered.",
          tags: ["order"],
          links: [],
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
      "Key findings: Ordered result — The chunks remained ordered.",
    );
    assert.doesNotMatch(
      (result as { summary: string }).summary,
      /unsupported|script|unsafe/i,
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

Deno.test("distil retains and validates PDF page provenance", async () => {
  const originalFetch = globalThis.fetch;
  const originalMaxChars = config.ingest.maxChars;
  const originalOverlap = config.ingest.overlap;
  const extractionChunks: string[] = [];
  let finalSourcePages = [2, 1, 2];

  try {
    config.ingest.maxChars = 30;
    config.ingest.overlap = 0;
    globalThis.fetch = (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const [system, user] = request.messages.map((message) => message.content);
      if (system.includes("compiling source material")) {
        extractionChunks.push(user);
        const page = Number(user.match(/^## PDF page (\d+)/)?.[1]);
        assert.ok(page > 0);
        return Promise.resolve(chatResponse(JSON.stringify({
          items: [{
            title: `Page ${page} evidence ${extractionChunks.length}`,
            type: "concept",
            body: `Evidence extracted from page ${page}.`,
            tags: ["evidence"],
            links: [],
            source_pages: [page],
          }],
        })));
      }

      const payload = JSON.parse(user) as {
        candidates: Array<{ source_pages?: number[] }>;
      };
      assert.ok(
        payload.candidates.every((candidate) =>
          candidate.source_pages?.length === 1
        ),
      );
      return Promise.resolve(chatResponse(JSON.stringify({
        summary: "Evidence appears on two PDF pages.",
        notes: [{
          title: "Page-aware evidence",
          type: "synthesis",
          body: "Evidence was consolidated with page provenance.",
          tags: ["evidence"],
          links: [],
          source_pages: finalSourcePages,
        }],
      })));
    };

    const transcript = `## PDF page 1\n\n${
      "A".repeat(50)
    }\n\n## PDF page 2\n\n${"B".repeat(30)}`;
    const result = await distil(
      transcript,
      "http://stub.invalid/v1",
      "test-key",
      undefined,
      2,
    );
    assert.deepEqual(result.notes[0].sourcePages, [1, 2]);
    assert.ok(extractionChunks.length > 1);
    assert.ok(
      extractionChunks.every((chunk) => /^## PDF page \d+/.test(chunk)),
    );

    finalSourcePages = [3];
    await assert.rejects(
      distil(
        "## PDF page 1\n\nEvidence",
        "http://stub.invalid/v1",
        "test-key",
        undefined,
        2,
      ),
      /missing or out of range/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.ingest.maxChars = originalMaxChars;
    config.ingest.overlap = originalOverlap;
  }
});

Deno.test("rewriteNote limits the model to a validated page body", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  const existingPage: DistilNote = {
    title: "Accepted protocol",
    type: "concept",
    body: "The accepted threshold is 5 units.",
    tags: ["clinical", "shared"],
    links: ["Existing evidence"],
  };
  const newPage: DistilNote = {
    title: "Updated evidence",
    type: "synthesis",
    body: "The updated threshold is 6.5 units.",
    tags: ["shared", "operations"],
    links: ["Existing evidence", "Updated study"],
  };

  try {
    globalThis.fetch = (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Promise.resolve(chatResponse(JSON.stringify({
        body:
          "The threshold was previously 5 units and was updated to 6.5 units.",
      })));
    };

    assert.deepEqual(
      await rewriteNote(
        existingPage,
        [newPage],
        "merge",
        "http://stub.invalid/v1",
        "test-key",
        "test-model",
      ),
      {
        title: "Accepted protocol",
        type: "concept",
        body:
          "The threshold was previously 5 units and was updated to 6.5 units.",
        tags: ["clinical", "shared", "operations"],
        links: ["Existing evidence", "Updated study"],
      },
    );
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    const messages = requests[0].messages as Array<{ content: string }>;
    const payload = JSON.parse(messages[1].content) as Record<string, unknown>;
    assert.deepEqual(payload.existing_page, existingPage);
    assert.deepEqual(payload.new_pages, [newPage]);
    assert.equal("existing_markdown" in payload, false);

    let invalidCalls = 0;
    globalThis.fetch = () => {
      invalidCalls++;
      return Promise.resolve(chatResponse(JSON.stringify({
        body: "Unsupported body.\n\n## Sources\n\n- invented",
      })));
    };
    await assert.rejects(
      rewriteNote(
        existingPage,
        [newPage],
        "merge",
        "http://stub.invalid/v1",
        "test-key",
        "test-model",
      ),
      /invalid after one retry: Wiki page\.body must not contain compiler-managed Related or Sources headings/,
    );
    assert.equal(invalidCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
