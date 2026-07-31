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

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
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

  try {
    const parsed = JSON.parse(extractJson(content));
    return (parsed.items ?? []).map((n: Record<string, unknown>) => ({
      title: String(n.title ?? "Untitled"),
      body: String(n.body ?? ""),
      tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    }));
  } catch {
    return [];
  }
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

  const parsed = JSON.parse(extractJson(content));
  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error("Consolidation response missing 'notes' array");
  }

  return {
    summary: parsed.summary ?? "",
    notes: parsed.notes.map((n: Record<string, unknown>) => ({
      title: String(n.title ?? "Untitled"),
      body: String(n.body ?? ""),
      tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    })),
  };
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

  // Parallel extraction with small model
  const candidates = (await Promise.all(
    chunks.map((chunk) =>
      extractChunk(chunk, apiBase, apiKey, config.llm.extractModel)
    ),
  )).flat();

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
  existingNotes: Array<{ id: number; title: string }>,
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
    existing_notes: existingNotes,
  });

  try {
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

    const parsed = JSON.parse(extractJson(content));
    const decisions: IntegrationDecision[] = Array.isArray(parsed)
      ? parsed
      : parsed.decisions ?? [];

    while (decisions.length < newNotes.length) {
      decisions.push({ action: "new" });
    }
    return decisions.slice(0, newNotes.length);
  } catch {
    return newNotes.map(() => ({ action: "new" as const }));
  }
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
