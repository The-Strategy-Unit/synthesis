import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import {
  confirmDiscovery,
  discoveryBatchConfirmation,
  DiscoveryBatchInputError,
  discoveryEvidenceHash,
  DiscoveryStateError,
  generateDiscoveries,
  reviewDiscovery,
  reviewDiscoveryBatch,
  validateDiscoveryBatchRequest,
} from "./discovery.ts";
import { parseWikiPage, renderWikiPage } from "./wiki.ts";
import { buildWikiGraph } from "./wiki_graph.ts";

function modelResponse(discoveries: unknown[]): Response {
  return Response.json({
    choices: [{
      message: { content: JSON.stringify({ discoveries }) },
    }],
  });
}

Deno.test({
  name:
    "cross-source synthesis proposes consolidation and relationships for review",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-discovery-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    const originalReasoningEffort = config.llm.reasoningEffort;
    try {
      config.llm.reasoningEffort = "none";
      const sourceOneHash = "a".repeat(64);
      const sourceTwoHash = "b".repeat(64);
      const sourceThreeHash = "c".repeat(64);
      const sourceOne = db.sources.addSource(
        sourceOneHash,
        "Mechanism study",
        "https://example.test/mechanism",
        "text",
        `${dir}/source-one.txt`,
        "A mechanism study summary.",
      );
      const sourceTwo = db.sources.addSource(
        sourceTwoHash,
        "Assay study",
        "https://example.test/assay",
        "text",
        `${dir}/source-two.txt`,
        "An assay study summary.",
      );
      const sourceThree = db.sources.addSource(
        sourceThreeHash,
        "Constraint study",
        "https://example.test/constraint",
        "text",
        `${dir}/source-three.txt`,
        "A constraint study summary.",
      );
      const addPage = async (
        title: string,
        links: string[],
        sourceId: number,
        sourceTitle: string,
        sourceHash: string,
      ) => {
        const path = `${dir}/${title.toLowerCase()}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `Evidence recorded for ${title}.`,
            tags: ["discovery"],
            links,
          }, [{ title: sourceTitle, contentHash: sourceHash }]),
        );
        const id = db.notes.addNote(title, path, null, "text");
        db.sources.attachNoteSource(id, sourceId, "new");
        return { id, path };
      };
      const first = await addPage(
        "First mechanism",
        ["Second observation"],
        sourceOne,
        "Mechanism study",
        sourceOneHash,
      );
      const second = await addPage(
        "Second observation",
        [],
        sourceTwo,
        "Assay study",
        sourceTwoHash,
      );
      const third = await addPage(
        "Third constraint",
        [],
        sourceThree,
        "Constraint study",
        sourceThreeHash,
      );
      let calls = 0;
      globalThis.fetch = (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
          reasoning_effort?: string;
        };
        assert.match(body.messages[0].content, /hypothesis for human review/i);
        assert.equal(body.reasoning_effort, "none");
        const payload = JSON.parse(body.messages.at(-1)!.content) as {
          candidates: Array<{
            candidate_index: number;
            left: { id: number; source_ids: number[] };
            right: { id: number; source_ids: number[] };
          }>;
        };
        for (const candidate of payload.candidates) {
          assert.equal(
            candidate.left.source_ids.some((id) =>
              candidate.right.source_ids.includes(id)
            ),
            false,
          );
        }
        if (calls > 1) return Promise.resolve(modelResponse([]));
        return Promise.resolve(modelResponse(
          payload.candidates.slice(0, 2).map(
            (candidate, index) => ({
              candidate_index: candidate.candidate_index,
              relationship_type: index === 0
                ? "consolidation_candidate"
                : "shared_constraint",
              explanation: index === 0
                ? "The pages may describe the same durable concept."
                : "The pages may share a limiting factor.",
              significance: index === 0
                ? "Review whether one canonical page could retain both sources."
                : "The shared factor may explain differing results.",
              confidence: index === 0 ? 0.74 : 0.61,
            }),
          ),
        ));
      };

      const generated = await generateDiscoveries(
        db,
        [first.id, second.id, third.id],
        "http://127.0.0.1:11434/v1",
        "secret",
        "discovery-model",
      );
      const discoveries = generated.discoveries;
      assert.equal(discoveries.length, 2);
      assert.equal(generated.coverage.complete, true);
      assert.equal(generated.coverage.candidates, 2);
      assert.equal(generated.coverage.proposed, 2);
      assert.equal(discoveries[0].status, "pending");
      assert.equal(discoveries[0].pages.length, 2);
      assert.equal(discoveries[0].sources.length, 2);
      assert.equal(discoveries[0].proposalKind, "consolidation");
      assert.equal(
        discoveries[0].productionMethod,
        "llm_cross_source_review",
      );
      assert.equal(discoveries[0].model, "discovery-model");

      assert.equal(
        (await reviewDiscovery(db, discoveries[0].id, "investigating")).status,
        "investigating",
      );
      const confirmed = await confirmDiscovery(db, discoveries[0].id);
      assert.equal(confirmed.status, "confirmed");
      const confirmedSource = db.notes.getNote(confirmed.pages[0].id);
      assert.ok(confirmedSource);
      const updated = await Deno.readTextFile(confirmedSource.file_path);
      const updatedPage = parseWikiPage(updated);
      assert.ok(updatedPage.links.includes(confirmed.pages[1].title));
      assert.equal(
        updatedPage.relationships?.[0].type,
        confirmed.relationshipType,
      );
      assert.deepEqual(
        updatedPage.relationships?.[0].pageHashes,
        confirmed.pageHashes,
      );
      const graph = await buildWikiGraph(db);
      assert.ok(
        graph.links.some((link) =>
          link.kind === "explicit" &&
          link.source === confirmed.pages[0].id &&
          link.target === confirmed.pages[1].id
        ),
      );
      await assert.rejects(
        confirmDiscovery(db, discoveries[0].id),
        DiscoveryStateError,
      );

      assert.equal(
        (await reviewDiscovery(db, discoveries[1].id, "rejected")).status,
        "rejected",
      );
      const repeated = await generateDiscoveries(
        db,
        [first.id, second.id, third.id],
        "http://127.0.0.1:11434/v1",
        "secret",
        "discovery-model",
      );
      assert.deepEqual(repeated.discoveries, []);
      assert.equal(repeated.coverage.complete, true);
      assert.equal(calls, 1, "reviewed candidate pairs are not proposed again");
    } finally {
      globalThis.fetch = originalFetch;
      config.llm.reasoningEffort = originalReasoningEffort;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "cross-source synthesis rejects invented candidate IDs and same-source pairs",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-discovery-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const sourceHash = "d".repeat(64);
      const otherSourceHash = "e".repeat(64);
      const sourceId = db.sources.addSource(
        sourceHash,
        "First supplied source",
        null,
        "text",
        `${dir}/source.txt`,
        "A supplied source summary.",
      );
      const otherSourceId = db.sources.addSource(
        otherSourceHash,
        "Second supplied source",
        null,
        "text",
        `${dir}/other-source.txt`,
        "Another supplied source summary.",
      );
      const pageIds: number[] = [];
      for (
        const [title, currentSource, currentHash] of [
          ["Alpha", sourceId, sourceHash],
          ["Beta", sourceId, sourceHash],
          ["Gamma", otherSourceId, otherSourceHash],
        ] as const
      ) {
        const path = `${dir}/${title}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `Evidence for ${title}.`,
            tags: ["evidence"],
            links: [],
          }, [{ title: "Supplied source", contentHash: currentHash }]),
        );
        const id = db.notes.addNote(title, path, null, "text");
        db.sources.attachNoteSource(id, currentSource, "new");
        pageIds.push(id);
      }
      let calls = 0;
      globalThis.fetch = (_input, init) => {
        calls++;
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
        };
        const payload = JSON.parse(request.messages.at(-1)!.content) as {
          candidates: Array<{
            left: { source_ids: number[] };
            right: { source_ids: number[] };
          }>;
        };
        assert.ok(payload.candidates.length > 0);
        assert.ok(
          payload.candidates.every((candidate) =>
            !candidate.left.source_ids.some((id) =>
              candidate.right.source_ids.includes(id)
            )
          ),
        );
        return Promise.resolve(modelResponse([{
          candidate_index: 99_999,
          relationship_type: "supports",
          explanation: "A grounded relationship.",
          significance: "A grounded significance.",
          confidence: 0.7,
        }]));
      };

      await assert.rejects(
        generateDiscoveries(
          db,
          pageIds,
          "https://llm.example.test/v1",
          "secret",
          "discovery-model",
        ),
        /candidate_index is invalid/,
      );
      assert.equal(calls, 2, "invalid discovery output retries exactly once");
      assert.deepEqual(db.discoveries.getDiscoveries(), []);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "whole-vault synthesis considers pages without caller-supplied seeds",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-vault-scan-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const pageIds: number[] = [];
      for (
        const [index, title] of ["Capacity pressure", "Demand pressure"]
          .entries()
      ) {
        const hash = String(index + 6).repeat(64);
        const sourceId = db.sources.addSource(
          hash,
          `Conference talk ${index + 1}`,
          null,
          "youtube",
          `${dir}/source-${index + 1}.txt`,
          `Summary for conference talk ${index + 1}.`,
        );
        const path = `${dir}/page-${index + 1}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `${title} affects service planning.`,
            tags: ["planning"],
            links: [],
          }, [{ title: `Conference talk ${index + 1}`, contentHash: hash }]),
        );
        const pageId = db.notes.addNote(title, path, null, "youtube");
        db.sources.attachNoteSource(pageId, sourceId, "new");
        pageIds.push(pageId);
      }

      globalThis.fetch = (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
        };
        const payload = JSON.parse(request.messages.at(-1)!.content) as {
          candidates: Array<{ candidate_index: number }>;
        };
        assert.equal(payload.candidates.length, 1);
        return Promise.resolve(modelResponse([{
          candidate_index: payload.candidates[0].candidate_index,
          relationship_type: "analogous",
          explanation:
            "Both pages describe planning pressure, in distinct source contexts.",
          significance:
            "The comparison may expose a reusable planning pattern.",
          confidence: 0.68,
        }]));
      };
      const progress: Array<{ current: number; total: number }> = [];
      const generated = await generateDiscoveries(
        db,
        [],
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
        undefined,
        {
          scope: "vault",
          onProgress: ({ current, total }) => progress.push({ current, total }),
        },
      );
      const discoveries = generated.discoveries;
      assert.equal(discoveries.length, 1);
      assert.deepEqual(discoveries[0].pages.map((page) => page.id), pageIds);
      assert.deepEqual(progress, [{ current: 1, total: 1 }]);
      assert.deepEqual({
        candidates: generated.coverage.candidates,
        proposed: generated.coverage.proposed,
        remaining: generated.coverage.remaining,
        complete: generated.coverage.complete,
      }, {
        candidates: 1,
        proposed: 1,
        remaining: 0,
        complete: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "whole-vault synthesis considers a broad semantic neighbourhood",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-discovery-neighbourhood-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const titles = [
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
        "Foxtrot",
        "Golf",
        "Hotel",
        "India",
        "Juliet",
      ];
      const embedding = new Array(config.embed.dimensions).fill(0);
      embedding[0] = 1;
      for (const [index, title] of titles.entries()) {
        const hash = String(index).repeat(64);
        const sourceId = db.sources.addSource(
          hash,
          `Independent talk ${title}`,
          null,
          "youtube",
          `${dir}/source-${index}.txt`,
          `Summary ${title}.`,
        );
        const path = `${dir}/page-${index}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `Distinctive${title} evidence.`,
            tags: [],
            links: [],
          }, [{ title: `Independent talk ${title}`, contentHash: hash }]),
        );
        const pageId = db.notes.addNote(title, path, null, "youtube");
        db.sources.attachNoteSource(pageId, sourceId, "new");
        db.search.upsertEmbedding(pageId, embedding);
      }

      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(modelResponse([]));
      };
      const generated = await generateDiscoveries(
        db,
        [],
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
        undefined,
        { scope: "vault" },
      );

      assert.ok(
        generated.coverage.candidates >= 40,
        `expected a broad semantic frontier, got ${generated.coverage.candidates}`,
      );
      assert.equal(generated.coverage.evaluated, 20);
      assert.equal(generated.coverage.proposed, 0);
      assert.equal(calls, 4);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "candidate review resumes and remembers model omissions",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-discovery-resume-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const pageIds: number[] = [];
      const pagePaths: string[] = [];
      for (let index = 0; index < 4; index++) {
        const hash = String(index + 1).repeat(64);
        const sourceId = db.sources.addSource(
          hash,
          `Independent source ${index + 1}`,
          null,
          "text",
          `${dir}/source-${index + 1}.txt`,
          `Summary ${index + 1}.`,
        );
        const path = `${dir}/page-${index + 1}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title: `Planning concept ${index + 1}`,
            type: "concept",
            body: `Independent evidence about planning concept ${index + 1}.`,
            tags: ["planning"],
            links: [],
          }, [{ title: `Independent source ${index + 1}`, contentHash: hash }]),
        );
        const pageId = db.notes.addNote(
          `Planning concept ${index + 1}`,
          path,
          null,
          "text",
        );
        db.sources.attachNoteSource(pageId, sourceId, "new");
        pageIds.push(pageId);
        pagePaths.push(path);
      }

      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(modelResponse([]));
      };
      const first = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(first.coverage.candidates, 6);
      assert.equal(first.coverage.evaluated, 5);
      assert.equal(first.coverage.remaining, 1);
      assert.equal(first.coverage.complete, false);
      assert.ok(first.coverage.generation);

      await assert.rejects(
        generateDiscoveries(
          db,
          pageIds,
          "https://llm.example.test/v1",
          "secret",
          "discovery-model",
          undefined,
          {
            scope: "vault",
            generation: first.coverage.generation ?? undefined,
          },
        ),
        /scope or wiki evidence changed/,
      );

      const resumed = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
        undefined,
        { generation: first.coverage.generation ?? undefined },
      );
      assert.equal(resumed.coverage.evaluated, 6);
      assert.equal(resumed.coverage.remaining, 0);
      assert.equal(resumed.coverage.complete, true);
      assert.equal(calls, 2);

      const refreshed = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(refreshed.coverage.candidates, 6);
      assert.equal(refreshed.coverage.evaluated, 6);
      assert.equal(refreshed.coverage.complete, true);
      assert.equal(calls, 2, "unchanged reviewed pairs are not sent again");

      await Deno.writeTextFile(
        pagePaths[0],
        renderWikiPage({
          title: "Planning concept 1",
          type: "concept",
          body: "Materially revised independent evidence about planning.",
          tags: ["planning"],
          links: [],
        }, [{ title: "Independent source 1", contentHash: "1".repeat(64) }]),
      );
      const changed = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(changed.coverage.candidates, 6);
      assert.equal(changed.coverage.evaluated, 6);
      assert.equal(changed.coverage.complete, true);
      assert.equal(
        calls,
        3,
        "pairs touching changed evidence are reconsidered",
      );

      const otherModel = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "another-model",
      );
      assert.equal(otherModel.coverage.candidates, 6);
      assert.equal(otherModel.coverage.evaluated, 5);
      assert.equal(otherModel.coverage.remaining, 1);
      assert.equal(
        calls,
        4,
        "a different model receives a fresh review ledger",
      );
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "stale discovery evidence cannot be confirmed and is reconsidered",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-discovery-stale-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const pageIds: number[] = [];
      const pagePaths: string[] = [];
      for (let index = 0; index < 2; index++) {
        const sourceHash = String(index + 7).repeat(64);
        const sourceId = db.sources.addSource(
          sourceHash,
          `Stale source ${index + 1}`,
          null,
          "text",
          `${dir}/source-${index + 1}.txt`,
          `Stale summary ${index + 1}`,
        );
        const path = `${dir}/stale-${index + 1}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title: `Stale concept ${index + 1}`,
            type: "concept",
            body: `Evidence before revision ${index + 1}.`,
            tags: ["stale"],
            links: [],
          }, [{ title: `Stale source ${index + 1}`, contentHash: sourceHash }]),
        );
        const noteId = db.notes.addNote(
          `Stale concept ${index + 1}`,
          path,
          null,
          "text",
        );
        db.sources.attachNoteSource(noteId, sourceId, "new");
        pageIds.push(noteId);
        pagePaths.push(path);
      }

      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(modelResponse([{
          candidate_index: 0,
          relationship_type: "supports",
          explanation: "The supplied pages may report compatible evidence.",
          significance: "The possible support should be checked by a person.",
          confidence: 0.7,
        }]));
      };
      const initial = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(initial.discoveries.length, 1);

      await Deno.writeTextFile(
        pagePaths[0],
        renderWikiPage({
          title: "Stale concept 1",
          type: "concept",
          body: "Materially revised evidence that changes the comparison.",
          tags: ["stale"],
          links: [],
        }, [{ title: "Stale source 1", contentHash: "7".repeat(64) }]),
      );
      await assert.rejects(
        confirmDiscovery(db, initial.discoveries[0].id),
        /stale because its wiki evidence changed/,
      );

      const refreshed = await generateDiscoveries(
        db,
        pageIds,
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(refreshed.discoveries.length, 1);
      assert.notEqual(
        refreshed.discoveries[0].id,
        initial.discoveries[0].id,
      );
      assert.equal(calls, 2);

      const firstPage = parseWikiPage(
        await Deno.readTextFile(pagePaths[0]),
      );
      await Deno.writeTextFile(
        pagePaths[0],
        renderWikiPage({
          ...firstPage,
          links: ["Stale concept 2"],
        }, [{
          title: "Stale source 1",
          contentHash: "7".repeat(64),
        }]),
      );
      await assert.rejects(
        confirmDiscovery(db, refreshed.discoveries[0].id),
        /no longer has an unlinked page pair/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "highly consolidated pages remain eligible for cross-source synthesis",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-discovery-wide-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const sourceIds: number[] = [];
      for (let index = 0; index < 10; index++) {
        sourceIds.push(db.sources.addSource(
          `${index.toString(16)}`.repeat(64),
          `Conference talk ${index + 1}`,
          null,
          "youtube",
          `${dir}/source-${index + 1}.txt`,
          `Talk summary ${index + 1}`,
        ));
      }
      const addPage = async (title: string, attachedSources: number[]) => {
        const path = `${dir}/${title.toLowerCase().replaceAll(" ", "-")}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "synthesis",
            body: "A connected conference-wide theme is described.",
            tags: ["conference"],
            links: [],
          }, []),
        );
        const id = db.notes.addNote(title, path, null, "youtube");
        for (const sourceId of attachedSources) {
          db.sources.attachNoteSource(id, sourceId, "merge");
        }
        return id;
      };
      const consolidated = await addPage(
        "Consolidated theme",
        sourceIds.slice(0, 9),
      );
      const independent = await addPage("Independent theme", [sourceIds[9]]);

      globalThis.fetch = () =>
        Promise.resolve(modelResponse([{
          candidate_index: 0,
          relationship_type: "shared_constraint",
          explanation: "The pages may describe a shared conference constraint.",
          significance: "The possible connection warrants review.",
          confidence: 0.65,
        }]));
      const generated = await generateDiscoveries(
        db,
        [consolidated, independent],
        "https://llm.example.test/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(generated.coverage.eligiblePages, 2);
      assert.equal(generated.coverage.candidates, 1);
      assert.equal(generated.discoveries[0].sources.length, 10);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "discovery batches require exact confirmation and apply atomically",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-discovery-batch-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    try {
      assert.equal(discoveryBatchConfirmation("confirm", 2), "CONFIRM 2 LINKS");
      assert.throws(
        () =>
          validateDiscoveryBatchRequest({
            action: "confirm",
            ids: [1, 2],
            confirm: "CONFIRM ALL",
          }),
        DiscoveryBatchInputError,
      );

      const pages: Array<{
        id: number;
        path: string;
        markdown: string;
        evidenceHash: string;
      }> = [];
      for (let index = 0; index < 4; index++) {
        const hash = String(index + 1).repeat(64);
        const title = `Batch concept ${index + 1}`;
        const sourceId = db.sources.addSource(
          hash,
          `Batch source ${index + 1}`,
          null,
          "text",
          `${dir}/source-${index + 1}.txt`,
          `Summary ${index + 1}.`,
        );
        const path = `${dir}/page-${index + 1}.md`;
        const page = {
          title,
          type: "concept" as const,
          body: `Evidence for ${title}.`,
          tags: ["batch"],
          links: [],
        };
        const markdown = renderWikiPage(page, [{
          title: `Batch source ${index + 1}`,
          contentHash: hash,
        }]);
        await Deno.writeTextFile(path, markdown);
        const id = db.notes.addNote(title, path, null, "text");
        db.sources.attachNoteSource(id, sourceId, "new");
        pages.push({
          id,
          path,
          markdown,
          evidenceHash: await discoveryEvidenceHash(page, [sourceId]),
        });
      }

      const addDiscovery = (left: number, right: number, suffix: string) => {
        const id = db.discoveries.addDiscovery({
          fingerprint: `batch-${suffix}`,
          relationship_type: "supports",
          explanation: "The supplied pages describe compatible evidence.",
          significance: "The reviewed relationship can connect the pages.",
          page_ids_json: JSON.stringify([left, right]),
          page_hashes_json: JSON.stringify([
            pages.find((page) => page.id === left)!.evidenceHash,
            pages.find((page) => page.id === right)!.evidenceHash,
          ]),
          source_ids_json: JSON.stringify([left, right]),
          production_method: "test",
          model: "test-model",
          confidence: 0.7,
        });
        assert.ok(id);
        return id;
      };
      const firstId = addDiscovery(pages[0].id, pages[1].id, "first");
      const secondId = addDiscovery(pages[2].id, pages[3].id, "second");
      const request = validateDiscoveryBatchRequest({
        action: "confirm",
        ids: [firstId, secondId],
        confirm: "CONFIRM 2 LINKS",
      });

      await Deno.writeTextFile(pages[2].path, "not a wiki page");
      await assert.rejects(() => reviewDiscoveryBatch(db, request));
      assert.equal(await Deno.readTextFile(pages[0].path), pages[0].markdown);
      assert.equal(db.discoveries.getDiscovery(firstId)?.status, "pending");
      assert.equal(db.discoveries.getDiscovery(secondId)?.status, "pending");

      await Deno.writeTextFile(pages[2].path, pages[2].markdown);
      const confirmed = await reviewDiscoveryBatch(db, request);
      assert.equal(confirmed.linksAdded, 2);
      assert.deepEqual(
        confirmed.reviewed.map((discovery) => discovery.status),
        ["confirmed", "confirmed"],
      );
      assert.ok(
        parseWikiPage(await Deno.readTextFile(pages[0].path)).links.includes(
          "Batch concept 2",
        ),
      );
      assert.ok(
        parseWikiPage(await Deno.readTextFile(pages[2].path)).links.includes(
          "Batch concept 4",
        ),
      );

      const rejectedId = addDiscovery(pages[0].id, pages[2].id, "rejected");
      const rejected = await reviewDiscoveryBatch(
        db,
        validateDiscoveryBatchRequest({
          action: "reject",
          ids: [rejectedId],
          confirm: "REJECT 1 PROPOSALS",
        }),
      );
      assert.equal(rejected.linksAdded, 0);
      assert.equal(rejected.reviewed[0].status, "rejected");
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
