import assert from "node:assert/strict";

import { config } from "./config.ts";
import {
  chatCompletion,
  parseJsonResponse,
  structuredChatCompletion,
} from "./llm.ts";

function completion(content: string, finishReason = "stop"): Response {
  return Response.json({
    choices: [{
      finish_reason: finishReason,
      message: { content },
    }],
  });
}

Deno.test("chat completions normalize local and remote provider requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalReasoningEffort = config.llm.reasoningEffort;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    config.llm.reasoningEffort = "none";
    globalThis.fetch = (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(completion("result"));
    };

    await chatCompletion(
      "http://127.0.0.1:11434/v1",
      "ollama",
      "local-model",
      "System",
      "User",
      { temperature: 0.25, maxTokens: 321, jsonMode: true },
    );
    await chatCompletion(
      "https://ollama.example:11434/v1",
      "ollama",
      "server-model",
      "System",
      "User",
    );
    await chatCompletion(
      "https://provider.example/v1",
      "secret",
      "remote-model",
      "System",
      "User",
    );

    assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(requests[0].body.reasoning_effort, "none");
    assert.equal(requests[0].body.temperature, 0.25);
    assert.equal(requests[0].body.max_tokens, 321);
    assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
    assert.equal(requests[1].body.reasoning_effort, "none");
    assert.equal("reasoning_effort" in requests[2].body, false);
  } finally {
    globalThis.fetch = originalFetch;
    config.llm.reasoningEffort = originalReasoningEffort;
  }
});

Deno.test("chat completions reject malformed or incomplete responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const cases: Array<[Response, RegExp]> = [
      [new Response(""), /invalid JSON response/],
      [Response.json({ choices: [] }), /choices must contain a completion/],
      [completion("partial", "length"), /exceeded the output token limit/],
      [completion(""), /content must not be empty/],
    ];
    for (const [response, expected] of cases) {
      globalThis.fetch = () => Promise.resolve(response);
      await assert.rejects(
        chatCompletion(
          "https://provider.example/v1",
          "secret",
          "model",
          "System",
          "User",
        ),
        expected,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("structured chat retries validation once but not provider failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const parse = (content: string) => {
    const value = parseJsonResponse(content, "Test response") as {
      ok?: unknown;
    };
    if (value.ok !== true) throw new Error("Test response.ok must be true");
    return value;
  };
  try {
    globalThis.fetch = (_input, init) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(completion(
        calls === 1 ? "not JSON" : '```json\n{"ok":true}\n```',
      ));
    };
    assert.deepEqual(
      await structuredChatCompletion(
        "Test response",
        "https://provider.example/v1",
        "secret",
        "model",
        "System",
        "User",
        { temperature: 0.4, jsonMode: true },
        parse,
      ),
      { ok: true },
    );
    assert.equal(calls, 2);
    assert.equal(bodies[1].temperature, 0);
    assert.match(
      JSON.stringify(bodies[1].messages),
      /previous response failed validation/,
    );

    calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(Response.json({ choices: [] }));
    };
    await assert.rejects(
      structuredChatCompletion(
        "Test response",
        "https://provider.example/v1",
        "secret",
        "model",
        "System",
        "User",
        { jsonMode: true },
        parse,
      ),
      /choices must contain a completion/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("structured chat retries truncated output with a bounded budget", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const parse = (content: string) =>
    parseJsonResponse(content, "Test response") as { ok: boolean };
  try {
    globalThis.fetch = (_input, init) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        calls === 1
          ? completion('{"ok":', "length")
          : completion('{"ok":true}'),
      );
    };

    assert.deepEqual(
      await structuredChatCompletion(
        "Test response",
        "https://provider.example/v1",
        "secret",
        "model",
        "System",
        "User",
        { jsonMode: true, maxTokens: 2_000, temperature: 0.4 },
        parse,
      ),
      { ok: true },
    );
    assert.equal(calls, 2);
    assert.equal(bodies[0].max_tokens, 2_000);
    assert.equal(bodies[1].max_tokens, 4_000);
    assert.equal(bodies[1].temperature, 0);
    assert.match(
      JSON.stringify(bodies[1].messages),
      /previous response reached its output limit/,
    );

    calls = 0;
    bodies.length = 0;
    globalThis.fetch = (_input, init) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(completion('{"ok":', "length"));
    };
    await assert.rejects(
      structuredChatCompletion(
        "Test response",
        "https://provider.example/v1",
        "secret",
        "model",
        "System",
        "User",
        { jsonMode: true, maxTokens: 16_000 },
        parse,
      ),
      /exceeded the output token limit/,
    );
    assert.equal(calls, 1, "the hard cap prevents unbounded retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
