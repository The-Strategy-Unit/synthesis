// Distil: transcript → extract (small model, parallel) → consolidate (big model)

import { config } from "./config.ts";

export interface DistilNote {
  title: string;
  body: string;
  tags: string[];
}

export interface DistilResult {
  summary: string;
  notes: DistilNote[];
}

const MAX_CHUNKS = 32;
const EXTRACTION_CONCURRENCY = 3;
const MAX_ITEMS_PER_CHUNK = 8;
const MAX_CANDIDATES = MAX_CHUNKS * MAX_ITEMS_PER_CHUNK;
const MAX_FINAL_NOTES = 12;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4_000;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_TAGS = 3;
const MAX_TAG_LENGTH = 64;

// --- Shared chat helper (one place for request construction) ---

async function chat(
  apiBase: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: opts.temperature ?? config.llm.temperature,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  // Only send reasoning_effort if not "none" — some providers don't support it
  if (config.llm.reasoningEffort !== "none") {
    body.reasoning_effort = config.llm.reasoningEffort;
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.security.modelTimeoutMs),
    });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "UnknownError";
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new Error("LLM request timed out");
    }
    console.error(`LLM API transport failed (${errorName})`);
    throw new Error("Unable to contact the LLM service");
  }

  if (!response.ok) {
    console.error(`LLM API request failed with status ${response.status}`);
    await response.body?.cancel();
    throw new Error(`LLM service rejected the request (${response.status})`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// --- JSON extraction utility ---

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1) {
    return text.slice(first, last + 1);
  }

  return text.trim();
}

// --- Transcript chunking ---

function splitTranscript(
  text: string,
  maxChars: number,
  overlap: number,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    chunks.push(text.slice(pos, end));
    if (end === text.length) break;
    pos = end - overlap;
  }
  return chunks;
}

// --- Stage 1: Extract (small model, runs in parallel per chunk) ---

const EXTRACT_PROMPT =
  `You are a knowledge extraction engine. Read the text and extract atomic facts, insights, definitions, procedures, and cautions.

Rules:
- Extract 3-8 items. Each item captures exactly ONE idea.
- Each title: 2-6 words, descriptive, unique.
- Each body: 1-3 sentences, self-contained. No references to "the video" or "the speaker".
- Only extract what is explicitly stated. Do not invent or speculate.
- Tags: 1-3 lowercase keywords.

Respond with ONLY JSON, no markdown fences:
{"items": [{"title": "...", "body": "...", "tags": ["..."]}]}`;

interface ExtractedItem {
  title: string;
  body: string;
  tags: string[];
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  const result = value.trim();
  if (result.length === 0) throw new Error(`${context} must not be empty`);
  if (result.length > maxLength) {
    throw new Error(`${context} exceeds ${maxLength} characters`);
  }
  return result;
}

function parseNote(value: unknown, context: string): DistilNote {
  const note = asRecord(value, context);
  if (!Array.isArray(note.tags)) {
    throw new Error(`${context}.tags must be an array`);
  }
  if (note.tags.length === 0 || note.tags.length > MAX_TAGS) {
    throw new Error(`${context}.tags must contain 1-${MAX_TAGS} items`);
  }

  return {
    title: boundedString(note.title, `${context}.title`, MAX_TITLE_LENGTH),
    body: boundedString(note.body, `${context}.body`, MAX_BODY_LENGTH),
    tags: note.tags.map((tag, index) =>
      boundedString(tag, `${context}.tags[${index}]`, MAX_TAG_LENGTH)
    ),
  };
}

function parseNoteArray(
  value: unknown,
  context: string,
  maxItems: number,
): DistilNote[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  if (value.length === 0 || value.length > maxItems) {
    throw new Error(`${context} must contain 1-${maxItems} notes`);
  }
  return value.map((note, index) => parseNote(note, `${context}[${index}]`));
}

async function extractChunk(
  chunk: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<ExtractedItem[]> {
  const content = await chat(apiBase, apiKey, model, EXTRACT_PROMPT, chunk, {
    temperature: config.llm.extractTemperature,
    maxTokens: config.llm.extractMaxTokens,
    jsonMode: true,
  });

  const parsed = asRecord(
    JSON.parse(extractJson(content)) as unknown,
    "Extraction response",
  );
  return parseNoteArray(
    parsed.items,
    "Extraction response.items",
    MAX_ITEMS_PER_CHUNK,
  );
}

// --- Stage 2: Consolidate (big model, single call) ---

const CONSOLIDATE_PROMPT =
  `You are a knowledge synthesis expert. You will receive a JSON list of candidate notes extracted from a source. Consolidate them into a clean, deduplicated set of atomic notes.

Rules:
- Merge near-duplicate candidates into single notes.
- Remove redundant or trivial items.
- Produce 5-12 final notes.
- Each title: 2-6 words, descriptive, unique. Titles serve as labels in a knowledge graph.
- Each body: 1-3 sentences, self-contained. No references to "the video" or "the speaker".
- Tags: 1-3 lowercase keywords.
- Also produce a 2-3 sentence summary of the overall source.
- Only include information present in the candidates. Do not invent.

Respond with ONLY JSON, no markdown fences:
{"summary": "...", "notes": [{"title": "...", "body": "...", "tags": ["..."]}]}`;

async function consolidateCandidates(
  candidates: ExtractedItem[],
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<DistilResult> {
  const content = await chat(
    apiBase,
    apiKey,
    model,
    CONSOLIDATE_PROMPT,
    JSON.stringify({ candidates }),
    {
      temperature: config.llm.consolidateTemperature,
      maxTokens: config.llm.consolidateMaxTokens,
      jsonMode: true,
    },
  );

  const parsed = asRecord(
    JSON.parse(extractJson(content)) as unknown,
    "Consolidation response",
  );

  return {
    summary: boundedString(
      parsed.summary,
      "Consolidation response.summary",
      MAX_SUMMARY_LENGTH,
    ),
    notes: parseNoteArray(
      parsed.notes,
      "Consolidation response.notes",
      MAX_FINAL_NOTES,
    ),
  };
}

async function extractChunks(
  chunks: string[],
  apiBase: string,
  apiKey: string,
): Promise<ExtractedItem[]> {
  const results = new Array<ExtractedItem[]>(chunks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      results[index] = await extractChunk(
        chunks[index],
        apiBase,
        apiKey,
        config.llm.extractModel,
      );
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(EXTRACTION_CONCURRENCY, chunks.length) },
      () => worker(),
    ),
  );
  return results.flat();
}

// --- Main distil entry point: split → parallel extract → consolidate ---

export async function distil(
  transcript: string,
  apiBase: string,
  apiKey: string,
): Promise<DistilResult> {
  const chunks = splitTranscript(
    transcript,
    config.ingest.maxChars,
    config.ingest.overlap,
  );
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(
      `Transcript requires ${chunks.length} chunks; maximum is ${MAX_CHUNKS}`,
    );
  }

  const candidates = await extractChunks(chunks, apiBase, apiKey);
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `Extraction produced ${candidates.length} candidates; expected 1-${MAX_CANDIDATES}`,
    );
  }

  // Single consolidation pass with big model
  return await consolidateCandidates(
    candidates,
    apiBase,
    apiKey,
    config.llm.consolidateModel,
  );
}

// --- Markdown rendering (unchanged) ---

export function noteToMarkdown(
  note: DistilNote,
  sourceUrl: string,
  sourceTitle: string,
): string {
  const frontmatter = [
    "---",
    `source: "${sourceTitle}"`,
    sourceUrl ? `url: "${sourceUrl}"` : null,
    `tags: [${note.tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
  ].filter(Boolean).join("\n");

  return `${frontmatter}\n\n# ${note.title}\n\n${note.body}\n`;
}

// --- Integration (small model) ---

const INTEGRATE_PROMPT =
  `You are a knowledge base integrator. You will receive a JSON object with "new_notes" and "existing_notes" arrays. For each new note, decide:

- "new": the note covers a topic not already in the wiki
- "merge": the note is a refinement/addition to an existing note — provide the existing note's id
- "contradict": the note contradicts or challenges an existing note — provide the existing note's id

You MUST respond with ONLY a JSON object (no markdown fences, no commentary). The format is:

{"decisions": [{"action": "new"}, {"action": "merge", "existing_id": 42}, {"action": "contradict", "existing_id": 17}]}

The decisions array must have exactly the same length and order as the input new_notes array.`;

export interface IntegrationDecision {
  action: "new" | "merge" | "contradict";
  existing_id?: number;
}

export async function integrate(
  newNotes: DistilNote[],
  existingNotes: Array<{ id: number; title: string; body?: string }>,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<IntegrationDecision[]> {
  if (existingNotes.length === 0) {
    return newNotes.map(() => ({ action: "new" as const }));
  }

  const userContent = JSON.stringify({
    new_notes: newNotes.map((n) => ({
      title: n.title,
      body: n.body.slice(0, 200),
    })),
    existing_notes: existingNotes.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body?.slice(0, 1_200),
    })),
  });

  const content = await chat(
    apiBase,
    apiKey,
    model,
    INTEGRATE_PROMPT,
    userContent,
    {
      temperature: config.llm.integrateTemperature,
      maxTokens: config.llm.integrateMaxTokens,
      jsonMode: true,
    },
  );

  const parsed = asRecord(
    JSON.parse(extractJson(content)) as unknown,
    "Integration response",
  );
  if (!Array.isArray(parsed.decisions)) {
    throw new Error("Integration response.decisions must be an array");
  }
  if (parsed.decisions.length !== newNotes.length) {
    throw new Error(
      `Integration response returned ${parsed.decisions.length} decisions; expected ${newNotes.length}`,
    );
  }

  const existingIds = new Set(existingNotes.map((note) => note.id));
  return parsed.decisions.map((value, index): IntegrationDecision => {
    const decision = asRecord(
      value,
      `Integration response.decisions[${index}]`,
    );
    if (
      decision.action !== "new" && decision.action !== "merge" &&
      decision.action !== "contradict"
    ) {
      throw new Error(
        `Integration response.decisions[${index}].action is invalid`,
      );
    }
    if (decision.action === "new") {
      if (decision.existing_id !== undefined) {
        throw new Error(
          `Integration response.decisions[${index}] must not include existing_id for action new`,
        );
      }
      return { action: "new" };
    }
    if (
      !Number.isSafeInteger(decision.existing_id) ||
      !existingIds.has(decision.existing_id as number)
    ) {
      throw new Error(
        `Integration response.decisions[${index}].existing_id is not a supplied note ID`,
      );
    }
    return {
      action: decision.action,
      existing_id: decision.existing_id as number,
    };
  });
}

// --- Note rewriting (big model) ---

const REWRITE_NOTE_PROMPT = `You are maintaining a knowledge wiki.

You will receive:
- an existing markdown note
- a new insight
- an action: "merge" or "contradict"

Rewrite the existing note so it stays clean, coherent, and self-contained.

Rules:
- Preserve the overall topic and title.
- Integrate the new insight naturally into the body.
- Do not just append a note at the end.
- If action is "contradict", clearly mention the disagreement inline using cautious language.
- Keep the result concise and readable.
- Return ONLY the full rewritten markdown note.`;

export async function rewriteNote(
  existingMarkdown: string,
  newInsight: string,
  action: "merge" | "contradict",
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const content = await chat(
    apiBase,
    apiKey,
    model,
    REWRITE_NOTE_PROMPT,
    JSON.stringify({
      action,
      existing_markdown: existingMarkdown,
      new_insight: newInsight,
    }),
    {
      temperature: config.llm.temperature,
      maxTokens: config.llm.rewriteMaxTokens,
    },
  );
  return content.trim();
}
