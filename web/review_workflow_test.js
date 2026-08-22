import assert from "node:assert/strict";

import {
  discoveryBatchConfirmation,
  discoveryCoverageSummary,
  discoveryMatchesFilter,
  formatPageRanges,
  ingestProgress,
  REVIEW_DECISIONS,
  reviewDecisionsForEveryChange,
  reviewDecisionSummary,
} from "./review_workflow.js";

Deno.test("discovery batches require an exact action and count", () => {
  assert.equal(discoveryBatchConfirmation("confirm", 12), "CONFIRM 12 LINKS");
  assert.equal(
    discoveryBatchConfirmation("reject", 12),
    "REJECT 12 PROPOSALS",
  );
  assert.throws(() => discoveryBatchConfirmation("confirm", 0), RangeError);
  assert.throws(() => discoveryBatchConfirmation("all", 2), TypeError);
});

Deno.test("discovery filters use relationship, page, and source context", () => {
  const discovery = {
    relationshipType: "shared_constraint",
    explanation: "Both services face limited analytical capacity.",
    significance: "The shared constraint may support joint planning.",
    pages: [{ title: "Rural service limits" }],
    sources: [{ title: "Conference talk B" }],
  };
  assert.equal(discoveryMatchesFilter(discovery, "rural", "all"), true);
  assert.equal(
    discoveryMatchesFilter(discovery, "conference talk", "shared_constraint"),
    true,
  );
  assert.equal(discoveryMatchesFilter(discovery, "capacity", "supports"), false);
  assert.equal(discoveryMatchesFilter(discovery, "unrelated", "all"), false);
});

Deno.test("discovery coverage reports resumable progress without claiming links", () => {
  assert.equal(
    discoveryCoverageSummary({
      candidates: 1694,
      evaluated: 20,
      proposed: 6,
      remaining: 1674,
      complete: false,
    }),
    "Evaluated 20 of 1694 candidate pairs; 1674 remaining; 6 proposals so far.",
  );
  assert.equal(
    discoveryCoverageSummary({
      candidates: 40,
      evaluated: 40,
      proposed: 8,
      remaining: 0,
      complete: true,
    }),
    "Sweep complete: 40 candidate pairs evaluated; 8 proposals require human review.",
  );
  assert.equal(
    discoveryCoverageSummary(undefined),
    "No unreviewed cross-source candidate pairs were found.",
  );
});

Deno.test("review requires a deliberate decision for every change", () => {
  assert.deepEqual(
    reviewDecisionSummary([
      REVIEW_DECISIONS.include,
      REVIEW_DECISIONS.pending,
    ]),
    { canApprove: false, exclude: 0, include: 1, pending: 1 },
  );
  assert.deepEqual(
    reviewDecisionSummary([
      REVIEW_DECISIONS.include,
      REVIEW_DECISIONS.exclude,
    ]),
    { canApprove: true, exclude: 1, include: 1, pending: 0 },
  );
});

Deno.test("source page evidence is compact and readable", () => {
  assert.equal(formatPageRanges([1, 2, 3, 5, 8, 9, 10]), "1–3, 5, 8–10");
  assert.equal(
    formatPageRanges(Array.from({ length: 50 }, (_, index) => index + 1)),
    "1–50",
  );
  assert.equal(formatPageRanges([4, 4, 0, -1, 3]), "3–4");
  assert.equal(formatPageRanges(undefined), "");
});

Deno.test("excluding every change cannot apply an empty approval", () => {
  assert.deepEqual(
    reviewDecisionSummary([
      REVIEW_DECISIONS.exclude,
      REVIEW_DECISIONS.exclude,
    ]),
    { canApprove: false, exclude: 2, include: 0, pending: 0 },
  );
  assert.equal(reviewDecisionSummary([]).canApprove, false);
});

Deno.test("trusted-source review can include every staged change at once", () => {
  const decisions = reviewDecisionsForEveryChange(
    4,
    REVIEW_DECISIONS.include,
  );
  assert.deepEqual(decisions, ["include", "include", "include", "include"]);
  assert.deepEqual(reviewDecisionSummary(decisions), {
    canApprove: true,
    exclude: 0,
    include: 4,
    pending: 0,
  });
});

Deno.test("bulk review refuses an incomplete or invalid decision", () => {
  assert.throws(
    () => reviewDecisionsForEveryChange(2, REVIEW_DECISIONS.pending),
    TypeError,
  );
  assert.throws(
    () => reviewDecisionsForEveryChange(-1, REVIEW_DECISIONS.include),
    RangeError,
  );
});

Deno.test("ingestion progress exposes the source-to-review handoff", () => {
  assert.deepEqual(ingestProgress("ingesting"), {
    draft: "pending",
    read: "current",
    review: "pending",
  });
  assert.deepEqual(ingestProgress("rewriting"), {
    draft: "current",
    read: "complete",
    review: "pending",
  });
  assert.deepEqual(ingestProgress("proposal"), {
    draft: "complete",
    read: "complete",
    review: "current",
  });
  assert.deepEqual(ingestProgress("done"), {
    draft: "complete",
    read: "complete",
    review: "complete",
  });
  assert.deepEqual(ingestProgress("error"), {
    draft: "pending",
    read: "pending",
    review: "pending",
  });
});

Deno.test("review is an application workspace, not a modal", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assert.match(html, /id="review-workspace" class="hidden"/);
  assert.match(html, /id="proposal-decision-summary" role="status"/);
  assert.match(html, /id="proposal-include-all"/);
  assert.match(html, /id="ingest-stages"/);
  assert.doesNotMatch(html, /id="review-modal"/);
  assert.doesNotMatch(html, /class="proposal-change-select"/);
});
