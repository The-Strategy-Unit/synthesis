import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";

function dbTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({
    name,
    permissions: "inherit",
    fn,
  });
}

async function withTempDb(test: (db: DB, dir: string) => void | Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "synthesis-db-test-" });
  const db = new DB(`${dir}/synthesis.db`);
  try {
    await test(db, dir);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

dbTest(
  "withTransaction rolls back all changes when an operation fails",
  async () => {
    await withTempDb((db, dir) => {
      assert.throws(
        () =>
          db.withTransaction(() => {
            db.addNote("Rolled back", `${dir}/rolled-back.md`, null, "text");
            throw new Error("stop transaction");
          }),
        /stop transaction/,
      );

      assert.deepEqual(db.getAllNotes(), []);
    });
  },
);

dbTest("duplicate file paths preserve the original note", async () => {
  await withTempDb((db, dir) => {
    const filePath = `${dir}/shared.md`;
    const originalId = db.addNote(
      "Original",
      filePath,
      "https://youtube.com/watch?v=original",
      "youtube",
    );

    assert.throws(() =>
      db.addNote(
        "Replacement",
        filePath,
        "https://youtube.com/watch?v=replacement",
        "youtube",
      )
    );

    const stored = db.getNoteByFilePath(filePath);
    assert.ok(stored);
    assert.deepEqual({
      id: stored.id,
      title: stored.title,
      file_path: stored.file_path,
      source_url: stored.source_url,
      source_type: stored.source_type,
    }, {
      id: originalId,
      title: "Original",
      file_path: filePath,
      source_url: "https://youtube.com/watch?v=original",
      source_type: "youtube",
    });
    assert.equal(db.getAllNotes().length, 1);
  });
});

dbTest("catalog replacement is complete and transactional", async () => {
  await withTempDb((db, dir) => {
    const oldSourceId = db.addSource(
      "old-source",
      "Old source",
      null,
      "text",
      `${dir}/old-source.txt`,
      "Old summary",
    );
    const oldNoteId = db.addNote(
      "Old note",
      `${dir}/old-note.md`,
      null,
      "text",
    );
    db.indexNote(oldNoteId, "Old note", "Old searchable content.");
    db.upsertEmbedding(oldNoteId, [
      1,
      ...Array<number>(config.embed.dimensions - 1).fill(0),
    ]);
    db.upsertLink(oldNoteId, oldNoteId, 1);
    db.attachNoteSource(oldNoteId, oldSourceId, "new");
    db.addIngestProposal(oldSourceId, '{"version":1,"changes":[]}');
    db.addDiscovery({
      fingerprint: "old-discovery",
      relationship_type: "supports",
      explanation: "Old explanation.",
      significance: "Old significance.",
      page_ids_json: JSON.stringify([oldNoteId]),
      source_ids_json: JSON.stringify([oldSourceId]),
      production_method: "test",
      model: "test-model",
      confidence: 0.5,
    });

    assert.throws(() =>
      db.replaceCatalog([], [{
        title: "Invalid replacement",
        filePath: `${dir}/invalid.md`,
        body: "Invalid body.",
        sourceHashes: ["missing-source"],
      }]), /unknown source/);
    assert.equal(db.getNote(oldNoteId)?.title, "Old note");
    assert.equal(db.getIngestProposals().length, 1);
    assert.equal(db.getDiscoveries().length, 1);

    db.replaceCatalog([{
      contentHash: "new-source",
      title: "New source",
      sourceUrl: "https://example.test/new",
      sourceType: "text",
      filePath: `${dir}/new-source.txt`,
      summary: "New summary",
    }], [{
      title: "New note",
      filePath: `${dir}/new-note.md`,
      body: "Replacement knowledge is searchable.",
      sourceHashes: ["new-source"],
    }]);

    assert.equal(db.getSourceByHash("old-source"), undefined);
    const newSource = db.getSourceByHash("new-source");
    assert.ok(newSource);
    const newNote = db.getNoteByExactTitle("New note");
    assert.ok(newNote);
    assert.deepEqual(
      db.searchKeyword("searchable").map((result) => result.id),
      [newNote.id],
    );
    assert.equal(db.getNotesForSource(newSource.id)[0].action, "reference");
    assert.equal(db.getEmbedding(oldNoteId), null);
    assert.deepEqual(db.getLinks(), []);
    assert.deepEqual(db.getIngestProposals(), []);
    assert.deepEqual(db.getDiscoveries(), []);
  });
});

dbTest(
  "source provenance can be added, found, attached, and listed",
  async () => {
    await withTempDb((db, dir) => {
      const sourceId = db.addSource(
        "content-hash",
        "Source title",
        "https://youtube.com/watch?v=source",
        "youtube",
        `${dir}/source.md`,
        "Source summary",
      );
      const noteId = db.addNote(
        "Derived note",
        `${dir}/note.md`,
        "https://youtube.com/watch?v=source",
        "youtube",
      );

      const source = db.getSourceByHash("content-hash");
      assert.ok(source);
      assert.deepEqual({ ...source }, {
        id: sourceId,
        content_hash: "content-hash",
        title: "Source title",
        source_url: "https://youtube.com/watch?v=source",
        source_type: "youtube",
        file_path: `${dir}/source.md`,
        summary: "Source summary",
        created_at: source.created_at,
      });

      db.attachNoteSource(noteId, sourceId, "new");
      assert.deepEqual(
        db.getNotesForSource(sourceId).map((note) => ({ ...note })),
        [{
          id: noteId,
          title: "Derived note",
          file_path: `${dir}/note.md`,
          source_url: "https://youtube.com/watch?v=source",
          action: "new",
        }],
      );

      db.attachNoteSource(noteId, sourceId, "merge");
      assert.equal(db.getNotesForSource(sourceId)[0].action, "merge");

      const secondSourceId = db.addSource(
        "second-content-hash",
        "Second source",
        null,
        "text",
        `${dir}/second-source.md`,
        "Second summary",
      );
      const secondNoteId = db.addNote(
        "Second derived note",
        `${dir}/second-note.md`,
        null,
        "text",
      );
      db.attachNoteSource(noteId, secondSourceId, "merge");
      db.attachNoteSource(secondNoteId, secondSourceId, "new");

      assert.deepEqual(
        db.getAllSources().map((item) => item.id),
        [secondSourceId, sourceId],
      );
      assert.equal(db.getSource(secondSourceId)?.title, "Second source");
      assert.equal(db.getSource(0), undefined);
      assert.equal(db.getSource(99_999), undefined);
      assert.deepEqual(
        db.getSourcesForNotes([noteId, noteId, secondNoteId, 0]).map((item) =>
          item.id
        ),
        [sourceId, secondSourceId],
      );
      assert.deepEqual(db.getSourcesForNotes([]), []);
      assert.deepEqual(
        db.getSourceProvenanceForNote(noteId).map((item) => ({
          id: item.id,
          action: item.action,
        })),
        [
          { id: sourceId, action: "merge" },
          { id: secondSourceId, action: "merge" },
        ],
      );
      assert.deepEqual(db.getSourceProvenanceForNote(0), []);
      assert.equal(db.getNoteByExactTitle("DERIVED NOTE")?.id, noteId);
      assert.equal(db.getNoteByExactTitle("Missing title"), undefined);
    });
  },
);

dbTest("ingest proposals have a guarded review lifecycle", async () => {
  await withTempDb((db, dir) => {
    const firstSourceId = db.addSource(
      "proposal-source-one",
      "First proposal source",
      null,
      "text",
      `${dir}/source-one.txt`,
      "First summary",
    );
    const secondSourceId = db.addSource(
      "proposal-source-two",
      "Second proposal source",
      null,
      "text",
      `${dir}/source-two.txt`,
      "Second summary",
    );
    const firstProposal = JSON.stringify({ version: 1, changes: [] });
    const secondProposal = JSON.stringify({ version: 1, changes: [1] });
    const firstId = db.addIngestProposal(firstSourceId, firstProposal);
    const secondId = db.addIngestProposal(secondSourceId, secondProposal);

    assert.equal(db.getIngestProposal(firstId)?.proposal_json, firstProposal);
    assert.equal(
      db.getIngestProposalForSource(secondSourceId)?.id,
      secondId,
    );
    assert.deepEqual(
      db.getIngestProposals("pending").map((proposal) => proposal.id),
      [secondId, firstId],
    );
    assert.equal(db.getIngestProposal(0), undefined);
    assert.equal(db.getIngestProposalForSource(0), undefined);

    assert.equal(db.reviewIngestProposal(firstId, "approved"), true);
    assert.equal(db.getIngestProposal(firstId)?.status, "approved");
    assert.ok(db.getIngestProposal(firstId)?.reviewed_at);
    assert.equal(db.reviewIngestProposal(firstId, "rejected"), false);

    assert.equal(db.reviewIngestProposal(secondId, "rejected"), true);
    assert.equal(db.getIngestProposal(secondId)?.status, "rejected");
    assert.deepEqual(db.getIngestProposals("pending"), []);
    assert.deepEqual(
      db.getIngestProposals().map((proposal) => proposal.id),
      [secondId, firstId],
    );
  });
});

dbTest(
  "discoveries are deduplicated and have guarded review states",
  async () => {
    await withTempDb((db) => {
      const discovery = {
        fingerprint: "supports|1,2|4",
        relationship_type: "supports",
        explanation: "The pages report compatible observations.",
        significance: "The connection may focus a follow-up review.",
        page_ids_json: "[1,2]",
        source_ids_json: "[4]",
        production_method: "llm_graph_review",
        model: "local-model",
        confidence: 0.72,
      };
      const firstId = db.addDiscovery(discovery);
      assert.ok(firstId);
      assert.equal(db.addDiscovery(discovery), undefined);
      assert.equal(db.getDiscovery(firstId)?.status, "pending");
      assert.deepEqual(
        db.getDiscoveries("pending").map((item) => item.id),
        [firstId],
      );

      assert.equal(db.reviewDiscovery(firstId, "investigating"), true);
      assert.equal(db.getDiscovery(firstId)?.status, "investigating");
      assert.equal(db.reviewDiscovery(firstId, "investigating"), false);
      assert.equal(db.reviewDiscovery(firstId, "confirmed"), true);
      assert.equal(db.getDiscovery(firstId)?.status, "confirmed");
      assert.equal(db.reviewDiscovery(firstId, "rejected"), false);

      const secondId = db.addDiscovery({
        ...discovery,
        fingerprint: "supports|1,2|4,5",
        source_ids_json: "[4,5]",
      });
      assert.ok(secondId);
      assert.equal(db.reviewDiscovery(secondId, "rejected"), true);
      assert.equal(db.getDiscovery(secondId)?.status, "rejected");
      assert.deepEqual(db.getDiscoveries("pending"), []);
      assert.deepEqual(
        db.getDiscoveries().map((item) => item.id),
        [secondId, firstId],
      );
    });
  },
);

dbTest(
  "incremental and full link recomputation maintain the expected graph",
  async () => {
    await withTempDb((db, dir) => {
      const first = db.addNote("First", `${dir}/first.md`, null, "text");
      const second = db.addNote("Second", `${dir}/second.md`, null, "text");
      const third = db.addNote("Third", `${dir}/third.md`, null, "text");
      const fourth = db.addNote("Fourth", `${dir}/fourth.md`, null, "text");

      const vector = (x: number, y: number, z: number): number[] => [
        x,
        y,
        z,
        ...Array<number>(config.embed.dimensions - 3).fill(0),
      ];
      db.upsertEmbedding(first, vector(1, 0, 0));
      db.upsertEmbedding(second, vector(0.8, 0.6, 0));
      db.upsertEmbedding(third, vector(0, 1, 0));
      db.upsertEmbedding(fourth, vector(0, 0, 1));

      db.upsertLink(first, third, 0.95);
      db.upsertLink(third, fourth, 0.88);

      assert.equal(db.computeLinksFor([first, first], 0.75, 4), 1);
      const incremental = db.getLinks().map((link) => ({ ...link }));
      assert.equal(
        incremental.filter((link) =>
          link.source === first && link.target === second
        ).length,
        1,
        "the qualifying pair must be created exactly once",
      );
      assert.equal(
        incremental.some((link) =>
          link.source === first && link.target === third
        ),
        false,
        "the stale touched link must be removed",
      );
      assert.equal(
        incremental.some((link) =>
          link.source === third && link.target === fourth &&
          link.similarity === 0.88
        ),
        true,
        "an unrelated link must survive incremental recomputation",
      );

      db.upsertLink(first, fourth, 0.99);
      assert.equal(db.computeLinks(0.75, 4), 1);
      const rebuilt = db.getLinks().map((link) => ({ ...link }));
      assert.equal(rebuilt.length, 1);
      assert.equal(rebuilt[0].source, first);
      assert.equal(rebuilt[0].target, second);
      assert.ok(Math.abs(rebuilt[0].similarity - 0.8) < 0.000_001);
    });
  },
);

dbTest(
  "integration candidates are relevant, limited, Unicode-aware, and safe",
  async () => {
    await withTempDb((db, dir) => {
      const programming = db.addNote(
        "C++ Memory Safety",
        `${dir}/programming.md`,
        null,
        "text",
      );
      const clinical = db.addNote(
        "Clinical Evidence",
        `${dir}/clinical.md`,
        null,
        "text",
      );
      const supplementary = db.addNote(
        "Supplementary Finding",
        `${dir}/supplementary.md`,
        null,
        "text",
      );
      const literalFoo = db.addNote(
        "Plain Note",
        `${dir}/plain.md`,
        null,
        "text",
      );
      db.indexNote(
        programming,
        "C++ Memory Safety",
        "A café uses a naïve compiler memory model.",
      );
      db.indexNote(
        clinical,
        "Clinical Evidence",
        "Cardiac rhythm evidence supports monitoring.",
      );
      db.indexNote(
        supplementary,
        "Supplementary Finding",
        "Additional cardiac rhythm observations.",
      );
      db.indexNote(literalFoo, "Plain Note", "A foo token appears only here.");

      assert.deepEqual(
        db.findIntegrationCandidates("memory", 5).map((note) => note.id),
        [programming],
        "a relevant title must be retrievable",
      );
      assert.deepEqual(
        db.findIntegrationCandidates("monitoring", 5).map((note) => note.id),
        [clinical],
        "a relevant body must be retrievable",
      );
      const limited = db.findIntegrationCandidates("cardiac rhythm", 1);
      assert.equal(limited.length, 1);
      assert.ok([clinical, supplementary].includes(limited[0].id));
      assert.equal(typeof limited[0].body, "string");

      assert.deepEqual(
        db.findIntegrationCandidates("CAFÉ naïve", 5).map((note) => note.id),
        [programming],
        "Unicode terms must remain searchable",
      );
      assert.deepEqual(
        db.findIntegrationCandidates("the AND or (a) * + -", 5),
        [],
        "stopwords and one-character noise must not create a query",
      );

      const adversarial = db.findIntegrationCandidates(
        'C++ "memory" OR (compiler*) title:foo',
        10,
      );
      assert.deepEqual(
        new Set(adversarial.map((note) => note.id)),
        new Set([programming, literalFoo]),
        "FTS-looking syntax must be reduced to safe literal tokens",
      );
    });
  },
);

dbTest("embedding vectors persist with integer note IDs", async () => {
  await withTempDb((db, dir) => {
    const noteId = db.addNote("Embedded", `${dir}/embedded.md`, null, "text");
    const embedding = Array.from(
      { length: config.embed.dimensions },
      (_, index) => index === 0 ? 1 : 0,
    );

    db.upsertEmbedding(noteId, embedding);

    assert.deepEqual(db.getEmbedding(noteId), embedding);
  });
});

dbTest(
  "hybrid search prioritizes literal matches and survives embedding failure",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempDb(async (db, dir) => {
        const exactId = db.addNote(
          "Plane Limitations",
          `${dir}/plane-limitations.md`,
          null,
          "text",
        );
        const relatedId = db.addNote(
          "Agent Flow Beta Status",
          `${dir}/agent-flow.md`,
          null,
          "text",
        );
        db.indexNote(
          exactId,
          "Plane Limitations",
          "Plane has several operational constraints.",
        );
        db.indexNote(
          relatedId,
          "Agent Flow Beta Status",
          "A flexible feature remains limited during beta.",
        );

        const queryEmbedding = Array(config.embed.dimensions).fill(0);
        queryEmbedding[0] = 1;
        const exactEmbedding = Array(config.embed.dimensions).fill(0);
        exactEmbedding[0] = 0.8;
        exactEmbedding[1] = 0.6;
        db.upsertEmbedding(exactId, exactEmbedding);
        db.upsertEmbedding(relatedId, queryEmbedding);

        globalThis.fetch = () =>
          Promise.resolve(Response.json({
            data: [{ embedding: queryEmbedding }],
          }));
        const hybrid = await db.search(
          "Plane limitations",
          "https://embed.example.test/v1",
          "secret",
          "embed",
        );
        assert.equal(hybrid[0].id, exactId);
        assert.equal(hybrid[0].matchType, "both");

        globalThis.fetch = () => Promise.reject(new Error("offline"));
        const fallback = await db.search(
          "Plane limitations",
          "https://embed.example.test/v1",
          "secret",
          "embed",
        );
        assert.deepEqual(
          fallback.map((result) => [result.id, result.matchType]),
          [[exactId, "keyword"]],
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
