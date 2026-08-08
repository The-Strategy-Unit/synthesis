export const REVIEW_DECISIONS = Object.freeze({
  exclude: "exclude",
  include: "include",
  pending: "pending",
});

export function reviewDecisionSummary(decisions) {
  const values = Array.isArray(decisions) ? decisions : [];
  const summary = { exclude: 0, include: 0, pending: 0 };
  for (const decision of values) {
    if (decision === REVIEW_DECISIONS.include) summary.include += 1;
    else if (decision === REVIEW_DECISIONS.exclude) summary.exclude += 1;
    else summary.pending += 1;
  }
  return {
    ...summary,
    canApprove: values.length > 0 && summary.pending === 0 &&
      summary.include > 0,
  };
}

export function formatPageRanges(pages) {
  const values = [
    ...new Set((Array.isArray(pages) ? pages : []).filter(
      (page) => Number.isSafeInteger(page) && page > 0,
    )),
  ].sort((left, right) => left - right);
  const ranges = [];
  for (const page of values) {
    const range = ranges.at(-1);
    if (range && page === range[1] + 1) range[1] = page;
    else ranges.push([page, page]);
  }
  return ranges.map(([start, end]) =>
    start === end ? `${start}` : `${start}–${end}`
  )
    .join(", ");
}

const INGEST_STAGE_STEP = Object.freeze({
  discoveries: "review",
  distilled: "draft",
  distilling: "draft",
  done: "review",
  extracting: "draft",
  ingested: "read",
  ingesting: "read",
  integrated: "review",
  integrating: "draft",
  linking: "review",
  proposal: "review",
  rewriting: "draft",
});

export function ingestProgress(stage) {
  if (stage === "done") {
    return { draft: "complete", read: "complete", review: "complete" };
  }
  const current = INGEST_STAGE_STEP[stage] ?? null;
  const steps = ["read", "draft", "review"];
  const currentIndex = steps.indexOf(current);
  return Object.fromEntries(steps.map((step, index) => [
    step,
    currentIndex < 0
      ? "pending"
      : index < currentIndex
      ? "complete"
      : index === currentIndex
      ? "current"
      : "pending",
  ]));
}
