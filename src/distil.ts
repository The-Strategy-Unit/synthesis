// Distil: transcript → atomic notes via OpenAI-compatible LLM

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

const SYSTEM_PROMPT =
  `You are a knowledge distillation expert. Your job is to extract atomic, self-contained insights from a transcript and return them as structured JSON.

Rules:
- Extract 5 to 15 notes. Each note captures exactly ONE idea, insight, definition, procedure, caution, or decision factor.
- Each note title must be descriptive, concise, and unique (2-6 words). Titles serve as labels in a knowledge graph.
- Each note body must be 1-3 sentences, written to make sense when read independently. Do not reference "the video" or "the speaker".
- Only extract information that is actually present in the transcript. Do not invent or speculate.
- Do not repeat the same idea across multiple notes.
- Prefer practical, actionable insights over vague commentary.
- Tags should be single words or short phrases, lowercase, no more than 3 per note.

You MUST respond with ONLY a JSON object, no markdown fences, no commentary. The format is:

{"summary": "2-3 sentence overview of the source", "notes": [{"title": "...", "body": "...", "tags": ["..."}]}`;

export async function distil(
  input: string,
  _title: string,
  _sourceUrl: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<DistilResult> {
  return await distilChunk(input, apiBase, apiKey, model);
}

async function distilChunk(
  text: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<DistilResult> {
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: config.llm.temperature,
      response_format: { type: "json_object" },
      reasoning_effort: config.llm.reasoningEffort,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  return parseDistilResponse(content);
}

function parseDistilResponse(content: string): DistilResult {
  const jsonStr = extractJson(content);
  const parsed = JSON.parse(jsonStr);

  if (!parsed.notes || !Array.isArray(parsed.notes)) {
    throw new Error("LLM response missing 'notes' array");
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

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: INTEGRATE_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: config.llm.integrateTemperature,
      response_format: { type: "json_object" },
      reasoning_effort: config.llm.reasoningEffort,
    }),
  });

  if (!response.ok) {
    return newNotes.map(() => ({ action: "new" as const }));
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  const jsonStr = extractJson(content);
  let decisions: IntegrationDecision[];
  try {
    const parsed = JSON.parse(jsonStr);
    decisions = Array.isArray(parsed) ? parsed : parsed.decisions ?? [];
  } catch {
    return newNotes.map(() => ({ action: "new" as const }));
  }

  while (decisions.length < newNotes.length) {
    decisions.push({ action: "new" });
  }
  return decisions.slice(0, newNotes.length);
}

const SUMMARY_PROMPT =
  `You are a precise summariser. Read the transcript and produce a dense, fact-rich summary in 500-800 words.

Rules:
- Preserve every key fact, definition, argument, procedure, and decision mentioned.
- Use clear, declarative sentences. No filler, no commentary, no "the speaker says".
- Organise by topic, not chronologically.
- Do not invent or speculate. Only include what is explicitly stated.
- Respond with plain text, no markdown formatting.`;

export async function summarise(
  transcript: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      temperature: config.llm.summariseTemperature,
      max_tokens: config.llm.maxTokens,
      reasoning_effort: config.llm.reasoningEffort,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Summary API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content as string;
}

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
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: REWRITE_NOTE_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            action,
            existing_markdown: existingMarkdown,
            new_insight: newInsight,
          }),
        },
      ],
      temperature: config.llm.temperature,
      reasoning_effort: config.llm.reasoningEffort,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}
