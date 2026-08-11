import { config } from "./config.ts";
import { parseJsonResponse, structuredChatCompletion } from "./llm.ts";
import { validateWikiPage, type WikiPage } from "./wiki.ts";
import { DEFAULT_WIKI_SCHEMA, promptWithWikiSchema } from "./wiki_schema.ts";

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
- Suggest a concise durable synthesis page title and tags.
- The server derives the synthesis body and links from the validated answer and citations.
- Keep uncertainty, disagreement, and contradictory evidence explicit.

Respond with ONLY JSON:
{"answer":"...","citations":[1,2],"suggested_page":{"title":"...","tags":["..."]}}`;

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

  const citedTitles = citations.map((id) => allowedById.get(id)!.title);
  const suggestedPageInput = asRecord(
    response.suggested_page,
    "Wiki answer.suggested_page",
  );
  const suggestedPage = validateWikiPage({
    title: suggestedPageInput.title,
    type: "synthesis",
    body: answer,
    tags: suggestedPageInput.tags,
    links: citedTitles,
  });

  return { answer, citations, suggestedPage };
}

export async function answerWiki(
  questionValue: unknown,
  pages: WikiQueryPage[],
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
): Promise<WikiAnswer> {
  const question = requiredText(
    questionValue,
    "Wiki question",
    MAX_QUESTION_LENGTH,
  );
  const context = validateContext(pages);
  return await structuredChatCompletion(
    "Wiki answer",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(QUERY_PROMPT, schema),
    JSON.stringify({ question, pages: context }),
    {
      temperature: 0.1,
      maxTokens: Math.max(config.llm.maxTokens, 2_000),
      jsonMode: true,
    },
    (content) =>
      validateWikiAnswer(parseJsonResponse(content, "Wiki answer"), context),
  );
}
