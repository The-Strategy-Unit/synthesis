// Distil: transcript → atomic notes via OpenAI-compatible LLM

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

{"summary": "2-3 sentence overview of the source", "notes": [{"title": "...", "body": "...", "tags": ["..."]}]}`;

const MAX_CHARS = 12000; // ~3000 tokens, safe for context window
const OVERLAP = 500;

export async function distil(
  transcript: string,
  _title: string,
  _sourceUrl: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<DistilResult> {
  const chunks = chunkText(transcript, MAX_CHARS, OVERLAP);

  if (chunks.length === 1) {
    return await distilChunk(chunks[0], apiBase, apiKey, model);
  }

  // Multiple chunks: distil each, concatenate results
  const results: DistilResult[] = [];
  for (const chunk of chunks) {
    const result = await distilChunk(chunk, apiBase, apiKey, model);
    results.push(result);
  }

  // Simple merge: combine summaries, concatenate notes
  return {
    summary: results.map((r) => r.summary).join(" "),
    notes: results.flatMap((r) => r.notes),
  };
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
      temperature: 0.3,
      response_format: { type: "json_object" },
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
  // Strip markdown fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Find first { and last } — handles preamble/postamble
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1) {
    return text.slice(first, last + 1);
  }

  return text.trim();
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

export function sanitizeTitle(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
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
