export const REVIEW_DECISIONS = Object.freeze({
  exclude: "exclude",
  include: "include",
  pending: "pending",
});

export const MAX_DISCOVERY_BATCH_ITEMS = 500;

export function discoveryBatchConfirmation(action, count) {
  if (action !== "confirm" && action !== "reject") {
    throw new TypeError("Discovery batch action must be confirm or reject");
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("Discovery batch count must be positive");
  }
  return action === "confirm"
    ? `CONFIRM ${count} LINKS`
    : `REJECT ${count} PROPOSALS`;
}

export function discoveryMatchesFilter(discovery, query, relationshipType) {
  if (!discovery || typeof discovery !== "object") return false;
  if (
    relationshipType && relationshipType !== "all" &&
    discovery.relationshipType !== relationshipType
  ) return false;
  const normalizedQuery = typeof query === "string"
    ? query.trim().toLocaleLowerCase("en-US")
    : "";
  if (!normalizedQuery) return true;
  const text = [
    discovery.relationshipType,
    discovery.explanation,
    discovery.significance,
    ...(Array.isArray(discovery.pages)
      ? discovery.pages.map((page) => page?.title)
      : []),
    ...(Array.isArray(discovery.sources)
      ? discovery.sources.map((source) => source?.title)
      : []),
  ].filter((value) => typeof value === "string").join(" ")
    .toLocaleLowerCase("en-US");
  return text.includes(normalizedQuery);
}

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

export function reviewDecisionsForEveryChange(changeCount, decision) {
  if (!Number.isSafeInteger(changeCount) || changeCount < 0) {
    throw new RangeError("Review change count must be a non-negative integer");
  }
  if (
    decision !== REVIEW_DECISIONS.include &&
    decision !== REVIEW_DECISIONS.exclude
  ) {
    throw new TypeError("Bulk review requires an Include or Exclude decision");
  }
  return Array.from({ length: changeCount }, () => decision);
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

export function discoveryCoverageSummary(coverage) {
  const value = coverage && typeof coverage === "object" ? coverage : {};
  const candidates = Number.isSafeInteger(value.candidates)
    ? Math.max(0, value.candidates)
    : 0;
  const evaluated = Number.isSafeInteger(value.evaluated)
    ? Math.min(candidates, Math.max(0, value.evaluated))
    : 0;
  const proposed = Number.isSafeInteger(value.proposed)
    ? Math.min(evaluated, Math.max(0, value.proposed))
    : 0;
  const remaining = Number.isSafeInteger(value.remaining)
    ? Math.min(candidates, Math.max(0, value.remaining))
    : Math.max(0, candidates - evaluated);
  if (value.complete === true || remaining === 0) {
    return candidates === 0
      ? "No unreviewed cross-source candidate pairs were found."
      : `Sweep complete: ${evaluated} candidate pairs evaluated; ${proposed} proposals require human review.`;
  }
  return `Evaluated ${evaluated} of ${candidates} candidate pairs; ${remaining} remaining; ${proposed} proposals so far.`;
}

const INGEST_STAGE_STEP = Object.freeze({
  automatic_applied: "review",
  automatic_proposal: "review",
  batch_complete: "review",
  batch_skipped: "review",
  batch_source: "read",
  batch_started: "read",
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
  synthesizing: "review",
  synthesis_progress: "review",
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
