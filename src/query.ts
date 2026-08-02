import { config } from "./config.ts";
import { validateWikiPage, type WikiPage } from "./wiki.ts";

export interface WikiQueryPage {
  id: number;
  title: string;
  content: string;
}

export interface WikiAnswer {
  answer: string;
  citations: number[];
  suggestedPage: WikiPage;
}

const MAX_QUESTION_LENGTH = 2_000;
const MAX_CONTEXT_PAGES = 12;
const MAX_PAGE_CONTENT_LENGTH = 12_000;
const MAX_ANSWER_LENGTH = 12_000;

const QUERY_PROMPT =
  `You answer questions using only the supplied compiled wiki pages.

Rules:
- Do not use outside knowledge or make unsupported claims.
- If the pages do not support an answer, say so clearly.
- Cite every material claim using the numeric page IDs supplied in the context.
- citations must contain every page ID used and no page ID that was not supplied.
- Produce a durable synthesis page whose body is exactly the answer.
- The synthesis page links must be exactly the titles of the cited pages.
- Keep uncertainty, disagreement, and contradictory evidence explicit.

Respond with ONLY JSON:
{"answer":"...","citations":[1,2],"suggested_page":{"title":"...","type":"synthesis","body":"...","tags":["..."],"links":["..."]}}`;

function requiredText(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${context} must not be empty`);
  if (text.length > maxLength) {
    throw new Error(`${context} exceeds ${maxLength} characters`);
  }
  return text;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last >= first
    ? text.slice(first, last + 1)
    : text.trim();
}

function validateContext(pages: WikiQueryPage[]): WikiQueryPage[] {
  if (pages.length === 0 || pages.length > MAX_CONTEXT_PAGES) {
    throw new Error(
      `Wiki query context must contain 1-${MAX_CONTEXT_PAGES} pages`,
    );
  }
  const ids = new Set<number>();
  return pages.map((page, index) => {
    if (!Number.isSafeInteger(page.id) || page.id < 1 || ids.has(page.id)) {
      throw new Error(
        `Wiki query context page ${index} has an invalid or duplicate ID`,
      );
    }
    ids.add(page.id);
    return {
      id: page.id,
      title: requiredText(
        page.title,
        `Wiki query context page ${index} title`,
        120,
      ),
      content: requiredText(
        page.content,
        `Wiki query context page ${index} content`,
        MAX_PAGE_CONTENT_LENGTH,
      ),
    };
  });
}

export function validateWikiAnswer(
  value: unknown,
  contextPages: WikiQueryPage[],
): WikiAnswer {
  const pages = validateContext(contextPages);
  const response = asRecord(value, "Wiki answer");
  const answer = requiredText(
    response.answer,
    "Wiki answer.answer",
    MAX_ANSWER_LENGTH,
  );
  if (!Array.isArray(response.citations) || response.citations.length === 0) {
    throw new Error("Wiki answer.citations must be a non-empty array");
  }

  const allowedById = new Map(pages.map((page) => [page.id, page]));
  const citations: number[] = [];
  const seen = new Set<number>();
  for (const citation of response.citations) {
    if (
      !Number.isSafeInteger(citation) || !allowedById.has(citation as number)
    ) {
      throw new Error("Wiki answer cites a page that was not supplied");
    }
    if (!seen.has(citation as number)) {
      seen.add(citation as number);
      citations.push(citation as number);
    }
  }

  const suggestedPage = validateWikiPage(response.suggested_page);
  if (suggestedPage.type !== "synthesis") {
    throw new Error("Wiki answer suggested_page.type must be synthesis");
  }
  if (suggestedPage.body !== answer) {
    throw new Error(
      "Wiki answer suggested_page.body must exactly match answer",
    );
  }
  const citedTitles = citations.map((id) => allowedById.get(id)!.title);
  const expectedLinks = new Set(
    citedTitles.map((title) => title.toLocaleLowerCase("en-US")),
  );
  const actualLinks = new Set(
    suggestedPage.links.map((title) => title.toLocaleLowerCase("en-US")),
  );
  if (
    expectedLinks.size !== actualLinks.size ||
    [...expectedLinks].some((title) => !actualLinks.has(title))
  ) {
    throw new Error(
      "Wiki answer suggested_page.links must match cited page titles",
    );
  }

  return { answer, citations, suggestedPage };
}

export async function answerWiki(
  questionValue: unknown,
  pages: WikiQueryPage[],
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<WikiAnswer> {
  const question = requiredText(
    questionValue,
    "Wiki question",
    MAX_QUESTION_LENGTH,
  );
  const context = validateContext(pages);
  let response: Response;
  try {
    response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: QUERY_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ question, pages: context }),
          },
        ],
        temperature: 0.1,
        max_tokens: Math.max(config.llm.maxTokens, 2_000),
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(config.security.modelTimeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("Wiki query timed out");
    }
    throw new Error("Unable to contact the LLM service for wiki query");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`LLM service rejected the wiki query (${response.status})`);
  }

  const payload = asRecord(await response.json(), "LLM response");
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new Error("LLM response.choices must be a non-empty array");
  }
  const choice = asRecord(payload.choices[0], "LLM response.choices[0]");
  const message = asRecord(choice.message, "LLM response.choices[0].message");
  const content = requiredText(
    message.content,
    "LLM response.choices[0].message.content",
    100_000,
  );
  return validateWikiAnswer(JSON.parse(extractJson(content)), context);
}
