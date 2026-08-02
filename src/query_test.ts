import assert from "node:assert/strict";

import { answerWiki, validateWikiAnswer, type WikiQueryPage } from "./query.ts";

const pages: WikiQueryPage[] = [
  {
    id: 7,
    title: "Treatment effect",
    content: "The evidence is mixed.\n\n## Sources\n\n- Trial A",
  },
  {
    id: 11,
    title: "Confidence assessment",
    content: "Two studies support the effect and one conflicts.",
  },
];

function validAnswer() {
  return {
    answer: "The evidence is mixed, with supporting and conflicting studies.",
    citations: [7, 11],
    suggested_page: {
      title: "Treatment evidence synthesis",
      type: "synthesis",
      body: "The evidence is mixed, with supporting and conflicting studies.",
      tags: ["treatment", "evidence"],
      links: ["Treatment effect", "Confidence assessment"],
    },
  };
}

Deno.test("wiki answers retain only supplied citations", () => {
  assert.deepEqual(
    validateWikiAnswer({ ...validAnswer(), citations: [7, 7, 11] }, pages),
    {
      answer: validAnswer().answer,
      citations: [7, 11],
      suggestedPage: validAnswer().suggested_page,
    },
  );
});

Deno.test("wiki answers reject ungrounded or divergent write-back", () => {
  const invalidAnswers = [
    { ...validAnswer(), citations: [] },
    { ...validAnswer(), citations: [999] },
    {
      ...validAnswer(),
      suggested_page: { ...validAnswer().suggested_page, type: "concept" },
    },
    {
      ...validAnswer(),
      suggested_page: {
        ...validAnswer().suggested_page,
        body: "A different unreviewed answer.",
      },
    },
    {
      ...validAnswer(),
      suggested_page: {
        ...validAnswer().suggested_page,
        links: ["Treatment effect"],
      },
    },
  ];
  for (const answer of invalidAnswers) {
    assert.throws(() => validateWikiAnswer(answer, pages));
  }
});

Deno.test("answerWiki sends bounded context and validates provider output", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = (input, init) => {
      requests.push({ input: String(input), init });
      return Promise.resolve(Response.json({
        choices: [{ message: { content: JSON.stringify(validAnswer()) } }],
      }));
    };

    const result = await answerWiki(
      "What does the evidence show?",
      pages,
      "https://api.example.test/v1",
      "secret-key",
      "synthesis-model",
    );
    assert.deepEqual(result.citations, [7, 11]);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].input,
      "https://api.example.test/v1/chat/completions",
    );
    assert.equal(
      new Headers(requests[0].init?.headers).get("Authorization"),
      "Bearer secret-key",
    );
    const body = JSON.parse(String(requests[0].init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    assert.equal(body.model, "synthesis-model");
    assert.doesNotMatch(JSON.stringify(body), /secret-key/);
    assert.match(body.messages[1].content, /What does the evidence show\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("answerWiki rejects malformed provider responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve(Response.json({ choices: [] }));
    await assert.rejects(
      answerWiki(
        "Question",
        pages,
        "https://api.example.test/v1",
        "key",
        "model",
      ),
      /choices must be a non-empty array/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
