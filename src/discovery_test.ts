import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import {
  confirmDiscovery,
  DiscoveryStateError,
  generateDiscoveries,
  reviewDiscovery,
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
  name: "discoveries are grounded, deduplicated, reviewed, and promoted",
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
      const sourceOne = db.addSource(
        sourceOneHash,
        "Mechanism study",
        "https://example.test/mechanism",
        "text",
        `${dir}/source-one.txt`,
        "A mechanism study summary.",
      );
      const sourceTwo = db.addSource(
        sourceTwoHash,
        "Assay study",
        "https://example.test/assay",
        "text",
        `${dir}/source-two.txt`,
        "An assay study summary.",
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
        const id = db.addNote(title, path, null, "text");
        db.attachNoteSource(id, sourceId, "new");
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
        sourceOne,
        "Mechanism study",
        sourceOneHash,
      );

      const suggestions = [
        {
          relationship_type: "mechanistic",
          explanation: "The mechanism and constraint may describe one process.",
          significance: "This could focus a follow-up evidence review.",
          page_ids: [first.id, third.id],
          source_ids: [sourceOne],
          confidence: 0.74,
        },
        {
          relationship_type: "shared_constraint",
          explanation:
            "The observation and constraint share a limiting factor.",
          significance: "The shared factor may explain divergent results.",
          page_ids: [second.id, third.id],
          source_ids: [sourceOne, sourceTwo],
          confidence: 0.61,
        },
      ];
      let calls = 0;
      globalThis.fetch = (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ content: string }>;
          reasoning_effort?: string;
        };
        assert.match(body.messages[0].content, /hypothesis for human review/i);
        assert.equal(body.reasoning_effort, "none");
        return Promise.resolve(modelResponse(suggestions));
      };

      const discoveries = await generateDiscoveries(
        db,
        [first.id],
        "http://127.0.0.1:11434/v1",
        "secret",
        "discovery-model",
      );
      assert.equal(discoveries.length, 2);
      assert.equal(discoveries[0].status, "pending");
      assert.deepEqual(discoveries[0].pages.map((page) => page.id), [
        first.id,
        third.id,
      ]);
      assert.deepEqual(discoveries[0].sources.map((source) => source.id), [
        sourceOne,
      ]);
      assert.equal(discoveries[0].productionMethod, "llm_graph_review");
      assert.equal(discoveries[0].model, "discovery-model");

      assert.equal(
        reviewDiscovery(db, discoveries[0].id, "investigating").status,
        "investigating",
      );
      const confirmed = await confirmDiscovery(db, discoveries[0].id);
      assert.equal(confirmed.status, "confirmed");
      const updated = await Deno.readTextFile(first.path);
      assert.deepEqual(parseWikiPage(updated).links, [
        "Second observation",
        "Third constraint",
      ]);
      assert.match(updated, new RegExp(`synthesis-source:${sourceOneHash}`));
      const graph = await buildWikiGraph(db);
      assert.ok(
        graph.links.some((link) =>
          link.kind === "explicit" && link.source === first.id &&
          link.target === third.id
        ),
      );
      await assert.rejects(
        confirmDiscovery(db, discoveries[0].id),
        DiscoveryStateError,
      );

      assert.equal(
        reviewDiscovery(db, discoveries[1].id, "rejected").status,
        "rejected",
      );
      const repeated = await generateDiscoveries(
        db,
        [first.id],
        "http://127.0.0.1:11434/v1",
        "secret",
        "discovery-model",
      );
      assert.deepEqual(repeated, []);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      config.llm.reasoningEffort = originalReasoningEffort;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "discovery generation rejects citations outside supplied provenance",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-discovery-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const sourceHash = "c".repeat(64);
      const sourceId = db.addSource(
        sourceHash,
        "Supplied source",
        null,
        "text",
        `${dir}/source.txt`,
        "A supplied source summary.",
      );
      const pageIds: number[] = [];
      for (const title of ["Alpha", "Beta"]) {
        const path = `${dir}/${title}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `Evidence for ${title}.`,
            tags: ["evidence"],
            links: [],
          }, [{ title: "Supplied source", contentHash: sourceHash }]),
        );
        const id = db.addNote(title, path, null, "text");
        db.attachNoteSource(id, sourceId, "new");
        pageIds.push(id);
      }
      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(modelResponse([{
          relationship_type: "supports",
          explanation: "A grounded relationship.",
          significance: "A grounded significance.",
          page_ids: pageIds,
          source_ids: [sourceId],
          confidence: 0.7,
        }, {
          relationship_type: "supports",
          explanation: "A purported relationship.",
          significance: "A purported significance.",
          page_ids: pageIds,
          source_ids: [99_999],
          confidence: 0.8,
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
        /source_ids contains an ID that was not supplied/,
      );
      assert.equal(calls, 2, "invalid discovery output retries exactly once");
      assert.deepEqual(db.getDiscoveries(), []);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
