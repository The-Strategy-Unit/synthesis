// Embed: generate embeddings via OpenAI-compatible API + compute semantic links

import type { DB } from "./db.ts";

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
  db.upsertEmbedding(noteId, model, embedding);
  return embedding;
}

// Compute semantic links between all notes for the graph view
export function computeLinks(
  db: DB,
  threshold = 0.55,
): number {
  const notes = db.getAllNotes();
  let linkCount = 0;

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const embA = db.getEmbedding(notes[i].id);
      const embB = db.getEmbedding(notes[j].id);
      if (!embA || !embB) continue;

      const sim = cosineSimilarity(embA, embB);
      if (sim >= threshold) {
        db.upsertLink(notes[i].id, notes[j].id, sim);
        linkCount++;
      }
    }
  }

  return linkCount;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
