import assert from "node:assert/strict";

import {
  searchMethodSummary,
  searchResultMetric,
  sortSearchResults,
} from "./search_results.js";

Deno.test("search method summaries make mode and ordering explicit", () => {
  assert.equal(
    searchMethodSummary("semantic"),
    "Semantic search · highest similarity first",
  );
  assert.equal(
    searchMethodSummary("keyword"),
    "Keyword search · highest relevance first",
  );
  assert.equal(
    searchMethodSummary("hybrid"),
    "Combined search · highest relevance first",
  );
});

Deno.test("search results sort by descending finite relevance and preserve ties", () => {
  const lower = { id: 1, score: 0.4 };
  const missing = { id: 2 };
  const firstTie = { id: 3, score: 0.8 };
  const secondTie = { id: 4, score: 0.8 };

  assert.deepEqual(
    sortSearchResults([lower, missing, firstTie, secondTie]),
    [firstTie, secondTie, lower, missing],
  );
  assert.deepEqual(
    sortSearchResults([lower, firstTie], "keyword"),
    [lower, firstTie],
  );
  assert.deepEqual(sortSearchResults(null), []);
});

Deno.test("search relevance labels expose their method without implying confidence", () => {
  assert.deepEqual(
    searchResultMetric({ score: 0.7421, matchType: "semantic" }),
    {
      text: "Semantic similarity 0.742",
      explanation:
        "Cosine similarity to this search; higher values rank earlier, but are not confidence probabilities.",
    },
  );
  assert.deepEqual(
    searchResultMetric({ score: 0.00001, matchType: "keyword" }, 3),
    {
      text: "Keyword rank 3",
      explanation:
        "Full-text relevance order for this search; rank 1 is the strongest keyword match.",
    },
  );
  assert.equal(searchResultMetric({ score: "invalid" }), null);
});
