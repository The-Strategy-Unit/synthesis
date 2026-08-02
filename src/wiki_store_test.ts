import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import type { ActiveProviders } from "./provider_runtime.ts";
import { parseWikiPage } from "./wiki.ts";
import { saveWikiSynthesis, WikiPageExistsError } from "./wiki_store.ts";

const providers: ActiveProviders = {
  source: "environment",
  llm: {
    apiBase: "https://api.example.test/v1",
    apiKey: "llm-key",
    extractModel: "model",
    consolidateModel: "model",
    integrateModel: "model",
    rewriteModel: "model",
  },
  embedding: {
    apiBase: "https://api.example.test/v1",
    apiKey: "embedding-key",
    model: "embedding-model",
  },
};

Deno.test({
  name: "cited wiki answers persist as sourced synthesis pages",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    const vault = await Deno.makeTempDir({ prefix: "synthesis-query-save-" });
    const db = new DB(`${vault}/synthesis.db`);
    let embeddingCalls = 0;
    try {
      config.vaultDir = vault;
      await Deno.mkdir(`${vault}/notes`, { recursive: true });
      const sourceHash = "a".repeat(64);
      const sourceId = db.addSource(
        sourceHash,
        "Controlled clinical study",
        "https://example.test/study",
        "text",
        `${vault}/sources/${sourceHash}/source.txt`,
        "Study summary.",
      );
      const citedId = db.addNote(
        "Treatment effect",
        `${vault}/notes/treatment-effect.md`,
        "https://example.test/study",
        "text",
      );
      await Deno.writeTextFile(
        `${vault}/notes/treatment-effect.md`,
        "# Treatment effect\n\nThe evidence is mixed.\n",
      );
      db.indexNote(citedId, "Treatment effect", "The evidence is mixed.");
      db.attachNoteSource(citedId, sourceId, "new");

      const embedding = Array.from(
        { length: config.embed.dimensions },
        (_, index) => index === 0 ? 1 : 0,
      );
      globalThis.fetch = () => {
        embeddingCalls++;
        return Promise.resolve(Response.json({ data: [{ embedding }] }));
      };

      const saved = await saveWikiSynthesis(
        db,
        {
          title: "Treatment evidence synthesis",
          type: "synthesis",
          body: "The available evidence is mixed.",
          tags: ["treatment", "evidence"],
          links: ["Treatment effect"],
        },
        [citedId],
        providers,
        "What does the treatment evidence show?",
      );
      assert.equal(embeddingCalls, 1);
      const stored = db.getNote(saved.id);
      assert.ok(stored);
      const markdown = await Deno.readTextFile(stored.file_path);
      assert.deepEqual(parseWikiPage(markdown), {
        title: "Treatment evidence synthesis",
        type: "synthesis",
        body: "The available evidence is mixed.",
        tags: ["treatment", "evidence"],
        links: ["Treatment effect"],
      });
      assert.match(markdown, new RegExp(`synthesis-source:${sourceHash}`));
      assert.deepEqual(
        db.getNotesForSource(sourceId).map((note) => ({
          title: note.title,
          action: note.action,
        })),
        [
          { title: "Treatment effect", action: "new" },
          { title: "Treatment evidence synthesis", action: "query" },
        ],
      );
      assert.ok(db.getEmbedding(saved.id));
      assert.ok(
        db.findIntegrationCandidates("available evidence mixed", 10).some(
          (candidate) => candidate.id === saved.id,
        ),
      );
      assert.match(
        await Deno.readTextFile(`${vault}/notes/index.md`),
        /\[\[Treatment evidence synthesis\]\]/,
      );
      assert.match(
        await Deno.readTextFile(`${vault}/notes/log.md`),
        /query \| What does the treatment evidence show\?/,
      );

      await assert.rejects(
        saveWikiSynthesis(
          db,
          {
            title: "Treatment evidence synthesis",
            type: "synthesis",
            body: "Duplicate.",
            tags: ["evidence"],
            links: ["Treatment effect"],
          },
          [citedId],
          providers,
          "Duplicate question",
        ),
        WikiPageExistsError,
      );
      assert.equal(
        embeddingCalls,
        1,
        "duplicate title must fail before embedding",
      );

      await assert.rejects(
        saveWikiSynthesis(
          db,
          {
            title: "Mismatched citations",
            type: "synthesis",
            body: "Mismatch.",
            tags: ["evidence"],
            links: [],
          },
          [citedId],
          providers,
          "Mismatch",
        ),
        /links must match/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(vault, { recursive: true });
    }
  },
});
