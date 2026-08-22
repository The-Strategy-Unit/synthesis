function numericScore(result) {
  const score = Number(result?.score);
  return Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
}

export function sortSearchResults(results, mode = "semantic") {
  if (!Array.isArray(results)) return [];
  if (mode === "keyword") return [...results];
  return results
    .map((result, index) => ({ result, index }))
    .sort((left, right) =>
      numericScore(right.result) - numericScore(left.result) ||
      left.index - right.index
    )
    .map(({ result }) => result);
}

export function searchMethodSummary(mode) {
  if (mode === "semantic") {
    return "Semantic search · highest similarity first";
  }
  if (mode === "keyword") {
    return "Keyword search · highest relevance first";
  }
  return "Combined search · highest relevance first";
}

function formatScore(score) {
  if (score === 0 || Math.abs(score) >= 0.001) return score.toFixed(3);
  return score.toExponential(2);
}

export function searchResultMetric(result, rank = 1) {
  const score = numericScore(result);
  if (result.matchType === "keyword") {
    return {
      text: `Keyword rank ${rank}`,
      explanation:
        "Full-text relevance order for this search; rank 1 is the strongest keyword match.",
    };
  }
  if (!Number.isFinite(score)) return null;

  if (result.matchType === "semantic") {
    return {
      text: `Semantic similarity ${formatScore(score)}`,
      explanation:
        "Cosine similarity to this search; higher values rank earlier, but are not confidence probabilities.",
    };
  }
  return {
    text: `Combined relevance ${formatScore(score)}`,
    explanation:
      "Combined keyword and semantic rank for this search; higher values rank earlier, but are not confidence probabilities.",
  };
}
