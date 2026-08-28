import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import { readIngestHistoryManifest } from "../vault/ingest_history.ts";
import {
  approveIngestProposal,
  IngestProposalApprovalError,
  IngestProposalStateError,
  InvalidWikiLinkError,
  rejectIngestProposal,
  stageSingleSource,
  StaleIngestProposalError,
} from "./orchestrate.ts";
import {
  findClaimCitations,
  parseWikiPage,
  renderWikiPage,
} from "../wiki/wiki.ts";

function modelJson(value: unknown): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(value) } }],
  });
}

async function withReviewVault(
  test: (db: DB, dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "synthesis-review-test-" });
  const originalVaultDir = config.vaultDir;
  let db: DB | undefined;
  try {
    config.vaultDir = dir;
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/sources`, { recursive: true });
    db = new DB(`${dir}/synthesis.db`);
    await test(db, dir);
  } finally {
    db?.close();
    config.vaultDir = originalVaultDir;
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "ingest proposals require approval or rejection before wiki mutation",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withReviewVault(async (db, dir) => {
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        let requests = 0;
        globalThis.fetch = () => {
          switch (requests++) {
            case 0:
              return Promise.resolve(modelJson({
                items: [{
                  title: "Reviewed concept",
                  type: "concept",
                  body: "A source-backed concept.",
                  tags: ["review"],
                  links: [],
                }],
              }));
            case 1:
              return Promise.resolve(modelJson({
                summary: "A bounded source summary.",
                notes: [{
                  title: "Reviewed concept",
                  type: "concept",
                  body: "A source-backed concept.",
                  tags: ["review"],
                  links: [],
                }],
              }));
            case 2:
              return Promise.resolve(Response.json({
                data: [{ embedding }],
              }));
            case 3:
              return Promise.resolve(modelJson({
                items: [{
                  title: "Rejected concept",
                  type: "concept",
                  body: "This proposal will be rejected.",
                  tags: ["review"],
                  links: [],
                }],
              }));
            case 4:
              return Promise.resolve(modelJson({
                summary: "A rejected source summary.",
                notes: [{
                  title: "Rejected concept",
                  type: "concept",
                  body: "This proposal will be rejected.",
                  tags: ["review"],
                  links: [],
                }],
              }));
            case 5:
              return Promise.resolve(modelJson({
                decisions: [{ action: "new" }],
              }));
            default:
              throw new Error(`Unexpected provider request ${requests}`);
          }
        };

        const source = {
          transcript: "The first source requires human review.",
          sourceUrl: "",
          title: "Review source",
        };
        const staged = await stageSingleSource(db, source, true, () => {});
        assert.equal(staged.kind, "proposal");
        if (staged.kind !== "proposal") return;
        assert.equal(staged.proposal.status, "pending");
        assert.equal(staged.proposal.changes[0].page.title, "Reviewed concept");
        assert.equal(requests, 2, "staging must not request an embedding");
        assert.deepEqual(db.notes.getAllNotes(), []);
        await assert.rejects(
          Deno.stat(`${dir}/notes/index.md`),
          Deno.errors.NotFound,
        );
        await assert.rejects(
          Deno.stat(`${dir}/notes/log.md`),
          Deno.errors.NotFound,
        );

        const repeated = await stageSingleSource(db, source, true, () => {});
        assert.equal(repeated.kind, "proposal");
        if (repeated.kind !== "proposal") return;
        assert.equal(repeated.proposal.id, staged.proposal.id);
        assert.equal(requests, 2, "re-staging must not call a provider");

        const applied = await approveIngestProposal(
          db,
          staged.proposal.id,
          () => {},
        );
        assert.equal(requests, 3);
        assert.equal(applied.newCount, 1);
        assert.ok(applied.historyId);
        assert.equal(db.notes.getAllNotes().length, 1);
        assert.equal(
          db.proposals.getIngestProposal(staged.proposal.id)?.status,
          "approved",
        );
        assert.match(
          await Deno.readTextFile(`${dir}/notes/index.md`),
          /\[\[Reviewed concept\]\]/,
        );
        const historyEntries = [...Deno.readDirSync(`${dir}/history`)];
        assert.equal(historyEntries.length, 1);
        const history = await readIngestHistoryManifest(
          `${dir}/history/${historyEntries[0].name}`,
        );
        assert.equal(history.historyId, applied.historyId);
        assert.equal(history.proposalId, staged.proposal.id);
        assert.equal(history.changes[0].notePath, "notes/reviewed-concept.md");
        assert.equal(history.changes[0].action, "new");
        await assert.rejects(
          approveIngestProposal(db, staged.proposal.id, () => {}),
          IngestProposalStateError,
        );
        assert.equal(requests, 3);

        const rejectedSource = {
          transcript: "The second source will be rejected.",
          sourceUrl: "",
          title: "Rejected source",
        };
        const rejectedStage = await stageSingleSource(
          db,
          rejectedSource,
          true,
          () => {},
        );
        assert.equal(rejectedStage.kind, "proposal");
        if (rejectedStage.kind !== "proposal") return;
        assert.equal(
          rejectIngestProposal(db, rejectedStage.proposal.id).status,
          "rejected",
        );
        assert.equal(db.notes.getAllNotes().length, 1);
        const repeatedRejected = await stageSingleSource(
          db,
          rejectedSource,
          true,
          () => {},
        );
        assert.equal(repeatedRejected.kind, "proposal");
        if (repeatedRejected.kind !== "proposal") return;
        assert.equal(repeatedRejected.proposal.status, "rejected");
        assert.equal(requests, 6);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "proposal approval applies only selected reviewed bodies",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withReviewVault(async (db) => {
        const embedding = Array.from(
          { length: config.embed.dimensions },
          (_, index) => index === 0 ? 1 : 0,
        );
        let requests = 0;
        globalThis.fetch = () => {
          switch (requests++) {
            case 0:
              return Promise.resolve(modelJson({
                items: [{
                  title: "First candidate",
                  type: "concept",
                  body: "The first candidate is not selected.",
                  tags: ["review"],
                  links: ["Second candidate"],
                }, {
                  title: "Second candidate",
                  type: "concept",
                  body: "The second candidate needs a wording correction.",
                  tags: ["review"],
                  links: ["First candidate"],
                }],
              }));
            case 1:
              return Promise.resolve(modelJson({
                summary: "This free-form summary is ignored.",
                notes: [{
                  title: "First candidate",
                  type: "concept",
                  body: "The first candidate is not selected.",
                  tags: ["review"],
                  links: ["Second candidate"],
                }, {
                  title: "Second candidate",
                  type: "concept",
                  body: "The second candidate needs a wording correction.",
                  tags: ["review"],
                  links: ["First candidate"],
                }],
              }));
            case 2:
              return Promise.resolve(Response.json({
                data: [{ embedding }],
              }));
            default:
              throw new Error(`Unexpected provider request ${requests}`);
          }
        };

        const staged = await stageSingleSource(
          db,
          {
            transcript: "A source proposing two independent pages.",
            sourceUrl: "",
            title: "Selective review source",
          },
          true,
          () => {},
        );
        assert.equal(staged.kind, "proposal");
        if (staged.kind !== "proposal") return;
        assert.equal(requests, 2);

        await assert.rejects(
          approveIngestProposal(db, staged.proposal.id, () => {}, undefined, {
            changes: [{ index: 2 }],
          }),
          IngestProposalApprovalError,
        );
        assert.equal(requests, 2);
        assert.equal(
          db.proposals.getIngestProposal(staged.proposal.id)?.status,
          "pending",
        );

        const applied = await approveIngestProposal(
          db,
          staged.proposal.id,
          () => {},
          undefined,
          {
            changes: [{
              index: 1,
              body: "The reviewed second candidate uses corrected wording.",
            }],
          },
        );
        assert.equal(requests, 3);
        assert.equal(applied.newCount, 1);
        assert.deepEqual(
          db.notes.getAllNotes().map((note) => note.title),
          ["Second candidate"],
        );
        const note = db.notes.getAllNotes()[0];
        const markdown = await Deno.readTextFile(note.file_path);
        assert.equal(
          parseWikiPage(markdown).body,
          "The reviewed second candidate uses corrected wording.",
        );
        assert.deepEqual(parseWikiPage(markdown).links, []);
        const source = db.sources.getAllSources()[0];
        assert.deepEqual(findClaimCitations(markdown), [{
          text: "The reviewed second candidate uses corrected wording.",
          sourceHashes: [source.content_hash],
        }]);
        assert.deepEqual(
          db.sources.getNotesForSource(source.id).map(({ title, action }) => ({
            title,
            action,
          })),
          [{ title: "Second candidate", action: "new" }],
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "approval refuses a proposal whose target page changed",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withReviewVault(async (db, dir) => {
        const notePath = `${dir}/notes/existing-concept.md`;
        const existingPage = renderWikiPage({
          title: "Existing concept",
          type: "concept",
          body: "Original durable knowledge.",
          tags: ["existing"],
          links: [],
        }, []);
        await Deno.writeTextFile(notePath, existingPage);
        const noteId = db.notes.addNote(
          "Existing concept",
          notePath,
          null,
          "text",
        );
        db.notes.indexNote(
          noteId,
          "Existing concept",
          "Original durable knowledge.",
        );

        let requests = 0;
        globalThis.fetch = () => {
          switch (requests++) {
            case 0:
              return Promise.resolve(modelJson({
                items: [{
                  title: "Existing concept update",
                  type: "concept",
                  body: "New source-backed knowledge.",
                  tags: ["existing"],
                  links: [],
                }],
              }));
            case 1:
              return Promise.resolve(modelJson({
                summary: "An update source summary.",
                notes: [{
                  title: "Existing concept update",
                  type: "concept",
                  body: "New source-backed knowledge.",
                  tags: ["existing"],
                  links: [],
                }],
              }));
            case 2:
              return Promise.resolve(modelJson({
                decisions: [{ action: "merge", existing_id: noteId }],
              }));
            case 3:
              return Promise.resolve(modelJson({
                body: "Original and new source-backed knowledge.",
              }));
            default:
              throw new Error("approval must fail before embedding");
          }
        };

        const staged = await stageSingleSource(
          db,
          {
            transcript: "Evidence that updates an existing concept.",
            sourceUrl: "",
            title: "Update source",
          },
          true,
          () => {},
        );
        assert.equal(staged.kind, "proposal");
        if (staged.kind !== "proposal") return;
        assert.equal(staged.proposal.changes[0].action, "merge");
        assert.equal(requests, 4);

        const changedPage = renderWikiPage({
          title: "Existing concept",
          type: "concept",
          body: "A different source changed this page after staging.",
          tags: ["existing"],
          links: [],
        }, []);
        await Deno.writeTextFile(notePath, changedPage);
        await assert.rejects(
          approveIngestProposal(db, staged.proposal.id, () => {}),
          StaleIngestProposalError,
        );
        assert.equal(requests, 4);
        assert.equal(
          db.proposals.getIngestProposal(staged.proposal.id)?.status,
          "pending",
        );
        assert.equal(await Deno.readTextFile(notePath), changedPage);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "local PDF staging archives original bytes and page provenance",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withReviewVault(async (db, dir) => {
        let requests = 0;
        globalThis.fetch = () => {
          requests++;
          return Promise.resolve(modelJson(
            requests === 1
              ? {
                items: [{
                  title: "Page-aware finding",
                  type: "concept",
                  body: "A finding supported on the second page.",
                  tags: ["evidence"],
                  links: [],
                  source_pages: [2],
                }],
              }
              : {
                summary: "A PDF containing a page-aware finding.",
                notes: [{
                  title: "Page-aware finding",
                  type: "concept",
                  body: "A finding supported on the second page.",
                  tags: ["evidence"],
                  links: [],
                  source_pages: [2],
                }],
              },
          ));
        };
        const originalBytes = new TextEncoder().encode(
          "%PDF-1.4 original binary bytes",
        );
        const transcript =
          "## PDF page 1\n\nBackground.\n\n## PDF page 2\n\nSupported finding.";
        const staged = await stageSingleSource(
          db,
          {
            transcript,
            sourceUrl: "",
            title: "Uploaded evidence",
            sourceType: "pdf",
            pageCount: 2,
            originalFile: {
              fileName: "evidence.pdf",
              mediaType: "application/pdf",
              bytes: originalBytes,
            },
          },
          false,
          () => {},
        );

        assert.equal(staged.kind, "proposal");
        if (staged.kind !== "proposal") return;
        assert.equal(requests, 2);
        assert.deepEqual(staged.proposal.changes[0].sourcePages, [2]);
        assert.match(staged.proposal.changes[0].markdown, /; pages: 2;/);
        assert.deepEqual(db.notes.getAllNotes(), []);

        const hashBytes = await crypto.subtle.digest(
          "SHA-256",
          originalBytes.slice().buffer,
        );
        const hash = Array.from(
          new Uint8Array(hashBytes),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const sourceDir = `${dir}/sources/${hash}`;
        assert.deepEqual(
          await Deno.readFile(`${sourceDir}/original.pdf`),
          originalBytes,
        );
        assert.equal(
          await Deno.readTextFile(`${sourceDir}/source.txt`),
          transcript,
        );
        assert.deepEqual(
          JSON.parse(await Deno.readTextFile(`${sourceDir}/meta.json`)),
          {
            contentHash: hash,
            title: "Uploaded evidence",
            sourceUrl: "",
            sourceType: "pdf",
            originalFileName: "evidence.pdf",
            mediaType: "application/pdf",
            pageCount: 2,
          },
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "approval revalidates explicit link targets",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withReviewVault(async (db, dir) => {
        const targetPath = `${dir}/notes/target.md`;
        const targetMarkdown = renderWikiPage({
          title: "Target",
          type: "concept",
          body: "Existing target knowledge.",
          tags: ["target"],
          links: [],
        }, []);
        await Deno.writeTextFile(targetPath, targetMarkdown);
        const targetId = db.notes.addNote("Target", targetPath, null, "text");
        db.notes.indexNote(targetId, "Target", "Existing target knowledge.");

        let requests = 0;
        globalThis.fetch = () => {
          switch (requests++) {
            case 0:
              return Promise.resolve(modelJson({
                items: [{
                  title: "New connection",
                  type: "concept",
                  body: "New knowledge connects to the target.",
                  tags: ["connection"],
                  links: ["Target update"],
                }, {
                  title: "Target update",
                  type: "concept",
                  body: "New evidence extends the target.",
                  tags: ["target"],
                  links: ["New connection"],
                }],
              }));
            case 1:
              return Promise.resolve(modelJson({
                summary: "A source connecting new and existing knowledge.",
                notes: [{
                  title: "New connection",
                  type: "concept",
                  body: "New knowledge connects to the target.",
                  tags: ["connection"],
                  links: ["Target update"],
                }, {
                  title: "Target update",
                  type: "concept",
                  body: "New evidence extends the target.",
                  tags: ["target"],
                  links: ["New connection"],
                }],
              }));
            case 2:
              return Promise.resolve(modelJson({
                decisions: [
                  { action: "new" },
                  { action: "merge", existing_id: targetId },
                ],
              }));
            case 3:
              return Promise.resolve(modelJson({
                body: "Existing and new target knowledge.",
              }));
            default:
              throw new Error("approval must reject before embedding");
          }
        };

        const staged = await stageSingleSource(
          db,
          {
            transcript: "Evidence connecting a new page to an existing target.",
            sourceUrl: "",
            title: "Connection source",
          },
          true,
          () => {},
        );
        assert.equal(staged.kind, "proposal");
        if (staged.kind !== "proposal") return;
        assert.equal(requests, 4);

        const duplicatePath = `${dir}/notes/duplicate-target.md`;
        await Deno.writeTextFile(duplicatePath, targetMarkdown);
        db.notes.addNote("Target", duplicatePath, null, "text");
        await assert.rejects(
          approveIngestProposal(db, staged.proposal.id, () => {}),
          InvalidWikiLinkError,
        );
        assert.equal(requests, 4);
        assert.equal(
          db.proposals.getIngestProposal(staged.proposal.id)?.status,
          "pending",
        );
        assert.equal(await Deno.readTextFile(targetPath), targetMarkdown);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
