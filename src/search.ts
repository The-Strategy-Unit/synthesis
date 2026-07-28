// Search: combine keyword (FTS5) and semantic (cosine similarity) results

import type { DB } from "./db.ts";
import { embedText } from "./embed.ts";

export interface SearchResult {
  id: number;
  title: string;
  score: number;
  matchType: "keyword" | "semantic" | "both";
}

export async function search(
  query: string,
  db: DB,
  apiBase: string,
  apiKey: string,
  embedModel: string,
  limit = 20,
): Promise<SearchResult[]> {
  // Run both searches in parallel
  const [keywordResults, queryEmbedding] = await Promise.all([
    Promise.resolve(db.searchKeyword(query, limit)),
    embedText(query, apiBase, apiKey, embedModel).catch(() => null),
  ]);

  const scores = new Map<number, { score: number; matchType: string }>();

  // Keyword results — FTS5 rank is negative (lower = better), normalize to 0-1
  for (const r of keywordResults) {
    const normalized = 1 / (1 + Math.abs(r.rank));
    scores.set(r.id, { score: normalized, matchType: "keyword" });
  }

  // Semantic results
  if (queryEmbedding) {
    const semanticResults = db.searchSemantic(queryEmbedding, limit);
    for (const r of semanticResults) {
      const existing = scores.get(r.note_id);
      if (existing) {
        // Blend: average of both scores, mark as "both"
        scores.set(r.note_id, {
          score: (existing.score + r.similarity) / 2,
          matchType: "both",
        });
      } else {
        scores.set(r.note_id, { score: r.similarity, matchType: "semantic" });
      }
    }
  }

  return Array.from(scores.entries())
    .map(([id, { score, matchType }]) => ({
      id,
      title: keywordResults.find((r) => r.id === id)?.title ??
        db.getNote(id)?.title ??
        "Untitled",
      score,
      matchType: matchType as "keyword" | "semantic" | "both",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
