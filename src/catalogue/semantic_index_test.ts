import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "./db.ts";
import {
  type ActiveProviders,
  embeddingIdentity,
} from "../provider/provider_runtime.ts";
import { rebuildSemanticIndex } from "./semantic_index.ts";
import { renderWikiPage } from "../wiki/wiki.ts";

Deno.test({
  name: "semantic index rebuild is bounded, resumable, and model-bound",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-semantic-test-" });
    const db = new DB(`${dir}/synthesis.db`);
    const originalFetch = globalThis.fetch;
    try {
      const providers: ActiveProviders = {
        source: "profile",
        llm: {
          apiBase: "https://llm.example.test/v1",
          apiKey: "llm-secret",
          extractModel: "chat",
          consolidateModel: "chat",
          integrateModel: "chat",
          rewriteModel: "chat",
        },
        embedding: {
          apiBase: "https://embed.example.test/v1",
          apiKey: "embedding-secret",
          model: "embed-one",
        },
      };
      for (let index = 0; index < 2; index++) {
        const sourceId = db.sources.addSource(
          String(index + 1).repeat(64),
          `Source ${index + 1}`,
          null,
          "text",
          `${dir}/source-${index + 1}.txt`,
          `Summary ${index + 1}`,
        );
        const path = `${dir}/page-${index + 1}.md`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title: `Page ${index + 1}`,
            type: "concept",
            body: `Related evidence ${index + 1}.`,
            tags: ["semantic"],
            links: [],
          }, []),
        );
        const noteId = db.notes.addNote(
          `Page ${index + 1}`,
          path,
          null,
          "text",
        );
        db.sources.attachNoteSource(noteId, sourceId, "new");
      }

      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(Response.json({
          data: [{
            embedding: [
              1,
              0.25,
              ...Array<number>(config.embed.dimensions - 2).fill(0),
            ],
          }],
        }));
      };

      const first = await rebuildSemanticIndex(db, providers, 1);
      assert.equal(first.processed, 1);
      assert.equal(first.complete, false);
      assert.equal(first.remaining, 1);
      assert.deepEqual(db.search.getLinks(), []);

      const second = await rebuildSemanticIndex(db, providers, 1);
      assert.equal(second.processed, 1);
      assert.equal(second.complete, true);
      assert.equal(second.remaining, 0);
      assert.equal(second.links, 1);
      assert.equal(calls, 2);

      const changed = db.search.activateSemanticIndex(embeddingIdentity({
        ...providers.embedding,
        model: "embed-two",
      }));
      assert.equal(changed.complete, false);
      assert.equal(changed.embedded, 0);
      assert.deepEqual(db.search.getLinks(), []);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "legacy unidentified embeddings are invalidated on database reopen",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-semantic-test-" });
    const path = `${dir}/synthesis.db`;
    try {
      const initial = new DB(path);
      const noteId = initial.notes.addNote(
        "Legacy",
        `${dir}/legacy.md`,
        null,
        "text",
      );
      initial.search.upsertEmbedding(
        noteId,
        [1, ...Array<number>(config.embed.dimensions - 1).fill(0)],
      );
      initial.search.upsertLink(noteId, noteId, 1);
      initial.close();

      const reopened = new DB(path);
      assert.equal(reopened.search.getEmbedding(noteId), null);
      assert.deepEqual(reopened.search.getLinks(), []);
      assert.equal(reopened.search.semanticIndexStatus().identity, null);
      reopened.close();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
