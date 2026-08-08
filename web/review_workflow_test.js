import assert from "node:assert/strict";

import {
  formatPageRanges,
  ingestProgress,
  REVIEW_DECISIONS,
  reviewDecisionSummary,
} from "./review_workflow.js";

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
  assert.match(html, /id="ingest-stages"/);
  assert.doesNotMatch(html, /id="review-modal"/);
  assert.doesNotMatch(html, /class="proposal-change-select"/);
});
