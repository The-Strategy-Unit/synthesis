// Embed: generate embeddings via OpenAI-compatible API + compute semantic links

import type { DB } from "./db.ts";
import { config } from "./config.ts";

export async function embedText(
  text: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<number[]> {
  const response = await fetch(`${apiBase}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.data[0].embedding as number[];
}

export async function embedAndStore(
  noteId: number,
  title: string,
  body: string,
  db: DB,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<number[]> {
  const text = `${title}\n${body}`;
  const embedding = await embedText(text, apiBase, apiKey, model);
  db.upsertEmbedding(noteId, embedding);
  return embedding;
}

// Compute semantic links between all notes for the graph view
export function computeLinks(
  db: DB,
  threshold = config.link.similarityThreshold,
  k = 50,
): number {
  const notes = db.getAllNotes();
  let linkCount = 0;
  const seen = new Set<string>();

  for (const note of notes) {
    const embedding = db.getEmbedding(note.id);
    if (!embedding) continue;

    const neighbours = db.findNearest(note.id, embedding, k);

    for (const n of neighbours) {
      if (n.id === note.id) continue;
      const similarity = n.similarity;
      if (similarity < threshold) continue;

      const key = `${Math.min(note.id, n.id)}-${Math.max(note.id, n.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      db.upsertLink(
        Math.min(note.id, n.id),
        Math.max(note.id, n.id),
        similarity,
      );
      linkCount++;
    }
  }

  return linkCount;
}
