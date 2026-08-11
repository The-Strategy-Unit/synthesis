import assert from "node:assert/strict";

import {
  parseStoredIngestProposal,
  serializeIngestProposal,
  validateIngestProposal,
  validateIngestProposalApproval,
} from "./ingest_proposal.ts";
import { renderWikiPage } from "./wiki.ts";

const page = renderWikiPage({
  title: "Evidence landscape",
  type: "synthesis",
  body: "The available evidence is mixed.",
  tags: ["evidence"],
  links: ["Primary study"],
}, []);

const existingPage = renderWikiPage({
  title: "Primary study",
  type: "entity",
  body: "The study reports a bounded result.",
  tags: ["study"],
  links: ["Evidence landscape"],
}, []);

Deno.test("ingest proposals round-trip through a validated stored form", () => {
  const proposal = {
    version: 1,
    sourceId: 7,
    contentHash: "a".repeat(64),
    changes: [
      { action: "new", markdown: page, ignored: "not persisted" },
      {
        action: "merge",
        pageId: 3,
        baseContentHash: "b".repeat(64),
        markdown: existingPage,
      },
    ],
    ignored: "not persisted",
  };

  const stored = serializeIngestProposal(proposal);
  assert.doesNotMatch(stored, /ignored/);
  const parsed = parseStoredIngestProposal(stored);
  assert.equal(parsed.sourceId, 7);
  assert.equal(parsed.reviewedChanges[0].page.title, "Evidence landscape");
  assert.equal(parsed.reviewedChanges[1].pageId, 3);
  assert.deepEqual(parsed.changes, [
    { action: "new", markdown: page },
    {
      action: "merge",
      pageId: 3,
      baseContentHash: "b".repeat(64),
      markdown: existingPage,
    },
  ]);
});

Deno.test("ingest proposals reject unsafe or stale-shaped data", () => {
  const valid = {
    version: 1,
    sourceId: 1,
    contentHash: "a".repeat(64),
    changes: [{ action: "new", markdown: page }],
  };

  assert.throws(
    () => validateIngestProposal({ ...valid, version: 2 }),
    /version must be 1/,
  );
  assert.throws(
    () => validateIngestProposal({ ...valid, contentHash: "unsafe" }),
    /SHA-256 digest/,
  );
  assert.throws(
    () =>
      validateIngestProposal({
        ...valid,
        changes: [{ action: "merge", pageId: 0, markdown: page }],
      }),
    /pageId must be a positive integer/,
  );
  assert.throws(
    () =>
      validateIngestProposal({
        ...valid,
        changes: [{ action: "replace", markdown: page }],
      }),
    /action must be new, merge, or contradict/,
  );
  assert.throws(
    () =>
      validateIngestProposal({
        ...valid,
        changes: [{ action: "new", markdown: "# Not compiled" }],
      }),
    /invalid frontmatter/,
  );
  assert.throws(
    () =>
      validateIngestProposal({
        ...valid,
        changes: Array.from({ length: 13 }, () => ({
          action: "new",
          markdown: page,
        })),
      }),
    /must contain 1-12 changes/,
  );
  assert.throws(
    () => parseStoredIngestProposal("not JSON"),
    /invalid JSON/,
  );
});

Deno.test("proposal approvals validate selected body edits", () => {
  assert.deepEqual(validateIngestProposalApproval({}), {});
  assert.deepEqual(
    validateIngestProposalApproval({
      changes: [{ index: 2, body: "  Reviewed\r\nbody.  " }, { index: 0 }],
    }),
    {
      changes: [{ index: 2, body: "Reviewed\nbody." }, { index: 0 }],
    },
  );

  for (
    const changes of [
      [],
      [{ index: -1 }],
      [{ index: 0 }, { index: 0 }],
      [{ index: 0, body: "  " }],
      [{ index: 0, body: "x".repeat(20_001) }],
    ]
  ) {
    assert.throws(() => validateIngestProposalApproval({ changes }));
  }
});
