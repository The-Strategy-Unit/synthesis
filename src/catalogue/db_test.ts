import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB, keywordSearchQueries } from "./db.ts";

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
            db.notes.addNote(
              "Rolled back",
              `${dir}/rolled-back.md`,
              null,
              "text",
            );
            throw new Error("stop transaction");
          }),
        /stop transaction/,
      );

      assert.deepEqual(db.notes.getAllNotes(), []);
    });
  },
);

dbTest("duplicate file paths preserve the original note", async () => {
  await withTempDb((db, dir) => {
    const filePath = `${dir}/shared.md`;
    const originalId = db.notes.addNote(
      "Original",
      filePath,
      "https://youtube.com/watch?v=original",
      "youtube",
    );

    assert.throws(() =>
      db.notes.addNote(
        "Replacement",
        filePath,
        "https://youtube.com/watch?v=replacement",
        "youtube",
      )
    );

    const stored = db.notes.getNoteByFilePath(filePath);
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
    assert.equal(db.notes.getAllNotes().length, 1);
  });
});

dbTest(
  "keyword search treats user text as text instead of FTS syntax",
  async () => {
    await withTempDb((db, dir) => {
      const teamId = db.notes.addNote(
        "Cross-Functional Team Composition",
        `${dir}/team.md`,
        null,
        "text",
      );
      const qualityId = db.notes.addNote(
        "Quality Improvement Definition",
        `${dir}/quality.md`,
        null,
        "text",
      );
      const communicationId = db.notes.addNote(
        "SBARR Communication Framework",
        `${dir}/communication.md`,
        null,
        "text",
      );
      db.notes.indexNote(
        teamId,
        "Cross-Functional Team Composition",
        "A team brings together clinical and operational perspectives.",
      );
      db.notes.indexNote(
        qualityId,
        "Quality Improvement Definition",
        "Quality improvement is a structured approach to systems change.",
      );
      db.notes.indexNote(
        communicationId,
        "SBARR Communication Framework",
        "Standardised communication supports safe handovers.",
      );

      assert.deepEqual(
        db.search.searchKeyword("cross-functional team").map((result) =>
          result.id
        ),
        [teamId],
      );
      assert.deepEqual(
        db.search.searchKeyword("What is quality improvement?").map((result) =>
          result.id
        ),
        [qualityId],
      );
      assert.deepEqual(
        db.search.searchKeyword("structured communication").map((result) =>
          result.id
        )
          .sort((a, b) => a - b),
        [qualityId, communicationId].sort((a, b) => a - b),
        "a broader OR search should run only when every meaningful term has no match",
      );
      assert.deepEqual(db.search.searchKeyword("?!"), []);
    });
  },
);

Deno.test("keyword queries are bounded, quoted, and stop-word aware", () => {
  assert.deepEqual(keywordSearchQueries("What is quality improvement?"), [
    '"quality" AND "improvement"',
    '"quality" OR "improvement"',
  ]);
  assert.deepEqual(keywordSearchQueries("cross-functional team"), [
    '"cross" AND "functional" AND "team"',
    '"cross" OR "functional" OR "team"',
  ]);
  assert.deepEqual(keywordSearchQueries("AND OR NOT ?"), [
    '"not"',
  ]);
  assert.deepEqual(keywordSearchQueries("?!"), []);
});

dbTest("catalogue replacement is complete and transactional", async () => {
  await withTempDb((db, dir) => {
    const oldSourceId = db.sources.addSource(
      "old-source",
      "Old source",
      null,
      "text",
      `${dir}/old-source.txt`,
      "Old summary",
    );
    const oldNoteId = db.notes.addNote(
      "Old note",
      `${dir}/old-note.md`,
      null,
      "text",
    );
    db.notes.indexNote(oldNoteId, "Old note", "Old searchable content.");
    db.search.upsertEmbedding(oldNoteId, [
      1,
      ...Array<number>(config.embed.dimensions - 1).fill(0),
    ]);
    db.search.upsertLink(oldNoteId, oldNoteId, 1);
    db.sources.attachNoteSource(oldNoteId, oldSourceId, "new");
    db.proposals.addIngestProposal(oldSourceId, '{"version":1,"changes":[]}');
    db.discoveries.addDiscovery({
      fingerprint: "old-discovery",
      relationship_type: "supports",
      explanation: "Old explanation.",
      significance: "Old significance.",
      page_ids_json: JSON.stringify([oldNoteId]),
      page_hashes_json: JSON.stringify(["a".repeat(64)]),
      source_ids_json: JSON.stringify([oldSourceId]),
      production_method: "test",
      model: "test-model",
      confidence: 0.5,
    });

    assert.throws(() =>
      db.maintenance.replaceCatalogue([], [{
        title: "Invalid replacement",
        filePath: `${dir}/invalid.md`,
        body: "Invalid body.",
        sourceHashes: ["missing-source"],
      }]), /unknown source/);
    assert.equal(db.notes.getNote(oldNoteId)?.title, "Old note");
    assert.equal(db.proposals.getIngestProposals().length, 1);
    assert.equal(db.discoveries.getDiscoveries().length, 1);

    db.maintenance.replaceCatalogue([{
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

    assert.equal(db.sources.getSourceByHash("old-source"), undefined);
    const newSource = db.sources.getSourceByHash("new-source");
    assert.ok(newSource);
    const newNote = db.notes.getNoteByExactTitle("New note");
    assert.ok(newNote);
    assert.deepEqual(
      db.search.searchKeyword("searchable").map((result) => result.id),
      [newNote.id],
    );
    assert.equal(
      db.sources.getNotesForSource(newSource.id)[0].action,
      "reference",
    );
    assert.equal(db.search.getEmbedding(oldNoteId), null);
    assert.deepEqual(db.search.getLinks(), []);
    assert.deepEqual(db.proposals.getIngestProposals(), []);
    assert.deepEqual(db.discoveries.getDiscoveries(), []);
  });
});

dbTest(
  "source provenance can be added, found, attached, and listed",
  async () => {
    await withTempDb((db, dir) => {
      const sourceId = db.sources.addSource(
        "content-hash",
        "Source title",
        "https://youtube.com/watch?v=source",
        "youtube",
        `${dir}/source.md`,
        "Source summary",
      );
      const noteId = db.notes.addNote(
        "Derived note",
        `${dir}/note.md`,
        "https://youtube.com/watch?v=source",
        "youtube",
      );

      const source = db.sources.getSourceByHash("content-hash");
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

      db.sources.attachNoteSource(noteId, sourceId, "new");
      assert.deepEqual(
        db.sources.getNotesForSource(sourceId).map((note) => ({ ...note })),
        [{
          id: noteId,
          title: "Derived note",
          file_path: `${dir}/note.md`,
          source_url: "https://youtube.com/watch?v=source",
          action: "new",
        }],
      );

      db.sources.attachNoteSource(noteId, sourceId, "merge");
      assert.equal(db.sources.getNotesForSource(sourceId)[0].action, "merge");

      const secondSourceId = db.sources.addSource(
        "second-content-hash",
        "Second source",
        null,
        "text",
        `${dir}/second-source.md`,
        "Second summary",
      );
      const secondNoteId = db.notes.addNote(
        "Second derived note",
        `${dir}/second-note.md`,
        null,
        "text",
      );
      db.sources.attachNoteSource(noteId, secondSourceId, "merge");
      db.sources.attachNoteSource(secondNoteId, secondSourceId, "new");

      assert.deepEqual(
        db.sources.getAllSources().map((item) => item.id),
        [secondSourceId, sourceId],
      );
      assert.equal(
        db.sources.getSource(secondSourceId)?.title,
        "Second source",
      );
      assert.equal(db.sources.getSource(0), undefined);
      assert.equal(db.sources.getSource(99_999), undefined);
      assert.deepEqual(
        db.sources.getSourcesForNotes([noteId, noteId, secondNoteId, 0]).map((
          item,
        ) => item.id),
        [sourceId, secondSourceId],
      );
      assert.deepEqual(db.sources.getSourcesForNotes([]), []);
      assert.deepEqual(
        db.sources.getSourceProvenanceForNote(noteId).map((item) => ({
          id: item.id,
          action: item.action,
        })),
        [
          { id: sourceId, action: "merge" },
          { id: secondSourceId, action: "merge" },
        ],
      );
      assert.deepEqual(db.sources.getSourceProvenanceForNote(0), []);
      assert.equal(db.notes.getNoteByExactTitle("DERIVED NOTE")?.id, noteId);
      assert.equal(db.notes.getNoteByExactTitle("Missing title"), undefined);
    });
  },
);

dbTest("ingest proposals have a guarded review lifecycle", async () => {
  await withTempDb((db, dir) => {
    const firstSourceId = db.sources.addSource(
      "proposal-source-one",
      "First proposal source",
      null,
      "text",
      `${dir}/source-one.txt`,
      "First summary",
    );
    const secondSourceId = db.sources.addSource(
      "proposal-source-two",
      "Second proposal source",
      null,
      "text",
      `${dir}/source-two.txt`,
      "Second summary",
    );
    const firstProposal = JSON.stringify({ version: 1, changes: [] });
    const secondProposal = JSON.stringify({ version: 1, changes: [1] });
    const firstId = db.proposals.addIngestProposal(
      firstSourceId,
      firstProposal,
    );
    const secondId = db.proposals.addIngestProposal(
      secondSourceId,
      secondProposal,
    );

    assert.equal(
      db.proposals.getIngestProposal(firstId)?.proposal_json,
      firstProposal,
    );
    assert.equal(
      db.proposals.getIngestProposalForSource(secondSourceId)?.id,
      secondId,
    );
    assert.deepEqual(
      db.proposals.getIngestProposals("pending").map((proposal) => proposal.id),
      [secondId, firstId],
    );
    assert.equal(db.proposals.getIngestProposal(0), undefined);
    assert.equal(db.proposals.getIngestProposalForSource(0), undefined);

    assert.equal(db.proposals.reviewIngestProposal(firstId, "approved"), true);
    assert.equal(db.proposals.getIngestProposal(firstId)?.status, "approved");
    assert.ok(db.proposals.getIngestProposal(firstId)?.reviewed_at);
    assert.equal(db.proposals.reviewIngestProposal(firstId, "rejected"), false);

    assert.equal(db.proposals.reviewIngestProposal(secondId, "rejected"), true);
    assert.equal(db.proposals.getIngestProposal(secondId)?.status, "rejected");
    assert.deepEqual(db.proposals.getIngestProposals("pending"), []);
    assert.deepEqual(
      db.proposals.getIngestProposals().map((proposal) => proposal.id),
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
        page_hashes_json: JSON.stringify(["a".repeat(64), "b".repeat(64)]),
        source_ids_json: "[4]",
        production_method: "llm_graph_review",
        model: "local-model",
        confidence: 0.72,
      };
      const firstId = db.discoveries.addDiscovery(discovery);
      assert.ok(firstId);
      assert.equal(db.discoveries.addDiscovery(discovery), undefined);
      assert.equal(db.discoveries.getDiscovery(firstId)?.status, "pending");
      assert.deepEqual(
        db.discoveries.getDiscoveries("pending").map((item) => item.id),
        [firstId],
      );

      assert.equal(
        db.discoveries.reviewDiscovery(firstId, "investigating"),
        true,
      );
      assert.equal(
        db.discoveries.getDiscovery(firstId)?.status,
        "investigating",
      );
      assert.equal(
        db.discoveries.reviewDiscovery(firstId, "investigating"),
        false,
      );
      assert.equal(db.discoveries.reviewDiscovery(firstId, "confirmed"), true);
      assert.equal(db.discoveries.getDiscovery(firstId)?.status, "confirmed");
      assert.equal(db.discoveries.reviewDiscovery(firstId, "rejected"), false);

      const secondId = db.discoveries.addDiscovery({
        ...discovery,
        fingerprint: "supports|1,2|4,5",
        source_ids_json: "[4,5]",
      });
      assert.ok(secondId);
      assert.equal(db.discoveries.reviewDiscovery(secondId, "rejected"), true);
      assert.equal(db.discoveries.getDiscovery(secondId)?.status, "rejected");
      assert.deepEqual(db.discoveries.getDiscoveries("pending"), []);
      assert.deepEqual(
        db.discoveries.getDiscoveries().map((item) => item.id),
        [secondId, firstId],
      );
    });
  },
);

dbTest("discovery candidate progress is resumable and guarded", async () => {
  await withTempDb((db, dir) => {
    const first = db.notes.addNote("First", `${dir}/first.md`, null, "text");
    const second = db.notes.addNote("Second", `${dir}/second.md`, null, "text");
    const base = {
      generation: "generation-one",
      left_note_id: first,
      right_note_id: second,
      left_hash: "a".repeat(64),
      right_hash: "b".repeat(64),
      prompt_version: "cross-source-v2",
      model: "local-model",
      score: 0.72,
      lexical_similarity: 0.2,
      semantic_similarity: 0.72,
    };
    db.discoveries.stageDiscoveryCandidates("generation-one", [{
      ...base,
      fingerprint: "candidate-one",
    }]);
    assert.deepEqual(
      db.discoveries.getDiscoveryCandidateCoverage("generation-one"),
      {
        total: 1,
        queued: 1,
        reviewed: 0,
        proposed: 0,
      },
    );
    assert.equal(
      db.discoveries.reviewDiscoveryCandidate(
        "generation-one",
        "candidate-one",
        "reviewed",
        null,
      ),
      true,
    );
    assert.equal(
      db.discoveries.reviewDiscoveryCandidate(
        "generation-one",
        "candidate-one",
        "reviewed",
        null,
      ),
      false,
    );

    db.discoveries.stageDiscoveryCandidates("generation-two", [{
      ...base,
      generation: "generation-two",
      fingerprint: "candidate-one",
    }]);
    assert.deepEqual(
      db.discoveries.getDiscoveryCandidateCoverage("generation-two"),
      {
        total: 1,
        queued: 0,
        reviewed: 1,
        proposed: 0,
      },
    );
    assert.equal(
      db.discoveries.getDiscoveryCandidates("generation-two", "reviewed", 1)[0]
        .fingerprint,
      "candidate-one",
    );

    db.discoveries.stageDiscoveryCandidates("generation-two", [{
      ...base,
      generation: "generation-two",
      fingerprint: "candidate-two",
    }]);
    const discoveryId = db.discoveries.addDiscovery({
      fingerprint: "supports|1,2|1,2",
      relationship_type: "supports",
      explanation: "Evidence supports a connection.",
      significance: "The connection may matter.",
      page_ids_json: JSON.stringify([first, second]),
      page_hashes_json: JSON.stringify(["a".repeat(64), "b".repeat(64)]),
      source_ids_json: "[1,2]",
      production_method: "test",
      model: "local-model",
      confidence: 0.7,
    });
    assert.ok(discoveryId);
    assert.equal(
      db.discoveries.reviewDiscoveryCandidate(
        "generation-two",
        "candidate-two",
        "proposed",
        discoveryId,
      ),
      true,
    );
    assert.throws(
      () =>
        db.discoveries.reviewDiscoveryCandidate(
          "generation-two",
          "candidate-one",
          "proposed",
          null,
        ),
      /require a discovery ID/,
    );

    db.notes.deleteNote(first);
    assert.deepEqual(
      db.discoveries.getDiscoveryCandidates("generation-two"),
      [],
    );
  });
});

dbTest(
  "semantic links require positive mutual cross-source neighbours",
  async () => {
    await withTempDb((db, dir) => {
      const first = db.notes.addNote("First", `${dir}/first.md`, null, "text");
      const second = db.notes.addNote(
        "Second",
        `${dir}/second.md`,
        null,
        "text",
      );
      const third = db.notes.addNote("Third", `${dir}/third.md`, null, "text");
      const fourth = db.notes.addNote(
        "Fourth",
        `${dir}/fourth.md`,
        null,
        "text",
      );
      const sharedSource = db.sources.addSource(
        "shared-source-hash",
        "Shared source",
        null,
        "text",
        `${dir}/shared-source.txt`,
        "",
      );
      const thirdSource = db.sources.addSource(
        "third-source-hash",
        "Third source",
        null,
        "text",
        `${dir}/third-source.txt`,
        "",
      );
      const fourthSource = db.sources.addSource(
        "fourth-source-hash",
        "Fourth source",
        null,
        "text",
        `${dir}/fourth-source.txt`,
        "",
      );
      db.sources.attachNoteSource(first, sharedSource, "new");
      db.sources.attachNoteSource(second, sharedSource, "new");
      db.sources.attachNoteSource(third, thirdSource, "new");
      db.sources.attachNoteSource(fourth, fourthSource, "new");

      const vector = (x: number, y: number, z: number): number[] => [
        x,
        y,
        z,
        ...Array<number>(config.embed.dimensions - 3).fill(0),
      ];
      db.search.upsertEmbedding(first, vector(1, 0, 0));
      db.search.upsertEmbedding(second, vector(0.9, 0.435_889_9, 0));
      db.search.upsertEmbedding(third, vector(0.8, 0.6, 0));
      db.search.upsertEmbedding(fourth, vector(0, 1, 0));

      db.search.upsertLink(first, second, 0.99);
      db.search.upsertLink(first, fourth, 0.98);

      assert.equal(db.search.computeLinksFor([first, first], 1), 1);
      const rebuilt = db.search.getLinks().map((link) => ({ ...link }));
      assert.equal(
        rebuilt.some((link) => link.source === first && link.target === second),
        false,
        "pages from the same source must not consume cross-source neighbours",
      );
      assert.equal(
        rebuilt.some((link) => link.source === second && link.target === third),
        true,
        "a mutually ranked cross-source neighbour must survive",
      );
      assert.equal(
        rebuilt.some((link) => link.source === first && link.target === fourth),
        false,
        "full recomputation must remove stale relationships",
      );
      assert.deepEqual(
        rebuilt.map((link) => [link.source, link.target]),
        [[second, third]],
      );

      assert.equal(db.search.computeLinksFor([], 1), 0);
      assert.throws(
        () => db.search.computeLinks(0),
        /must be a positive integer/,
      );
      assert.equal(db.search.getLinks().length, rebuilt.length);
    });
  },
);

dbTest(
  "orthogonal nearest neighbours do not become semantic links",
  async () => {
    await withTempDb((db, dir) => {
      const sharedSource = db.sources.addSource(
        "large-shared-source-hash",
        "Large shared source",
        null,
        "text",
        `${dir}/large-shared-source.txt`,
        "",
      );
      const externalSource = db.sources.addSource(
        "external-source-hash",
        "External source",
        null,
        "text",
        `${dir}/external-source.txt`,
        "",
      );
      const vector = (x: number, y: number): number[] => [
        x,
        y,
        ...Array<number>(config.embed.dimensions - 2).fill(0),
      ];
      for (let index = 0; index < 66; index++) {
        const noteId = db.notes.addNote(
          `Shared ${index}`,
          `${dir}/shared-${index}.md`,
          null,
          "text",
        );
        db.sources.attachNoteSource(noteId, sharedSource, "new");
        db.search.upsertEmbedding(noteId, vector(1, 0));
      }
      const external = db.notes.addNote(
        "External",
        `${dir}/external.md`,
        null,
        "text",
      );
      db.sources.attachNoteSource(external, externalSource, "new");
      db.search.upsertEmbedding(external, vector(0, 1));

      assert.equal(db.search.computeLinks(1), 0);
      const links = db.search.getLinks();
      assert.deepEqual(links, []);
    });
  },
);

dbTest(
  "integration candidates are relevant, limited, Unicode-aware, and safe",
  async () => {
    await withTempDb((db, dir) => {
      const programming = db.notes.addNote(
        "C++ Memory Safety",
        `${dir}/programming.md`,
        null,
        "text",
      );
      const clinical = db.notes.addNote(
        "Clinical Evidence",
        `${dir}/clinical.md`,
        null,
        "text",
      );
      const supplementary = db.notes.addNote(
        "Supplementary Finding",
        `${dir}/supplementary.md`,
        null,
        "text",
      );
      const literalFoo = db.notes.addNote(
        "Plain Note",
        `${dir}/plain.md`,
        null,
        "text",
      );
      db.notes.indexNote(
        programming,
        "C++ Memory Safety",
        "A café uses a naïve compiler memory model.",
      );
      db.notes.indexNote(
        clinical,
        "Clinical Evidence",
        "Cardiac rhythm evidence supports monitoring.",
      );
      db.notes.indexNote(
        supplementary,
        "Supplementary Finding",
        "Additional cardiac rhythm observations.",
      );
      db.notes.indexNote(
        literalFoo,
        "Plain Note",
        "A foo token appears only here.",
      );

      assert.deepEqual(
        db.search.findIntegrationCandidates("memory", 5).map((note) => note.id),
        [programming],
        "a relevant title must be retrievable",
      );
      assert.deepEqual(
        db.search.findIntegrationCandidates("monitoring", 5).map((note) =>
          note.id
        ),
        [clinical],
        "a relevant body must be retrievable",
      );
      const limited = db.search.findIntegrationCandidates("cardiac rhythm", 1);
      assert.equal(limited.length, 1);
      assert.ok([clinical, supplementary].includes(limited[0].id));
      assert.equal(typeof limited[0].body, "string");

      assert.deepEqual(
        db.search.findIntegrationCandidates("CAFÉ naïve", 5).map((note) =>
          note.id
        ),
        [programming],
        "Unicode terms must remain searchable",
      );
      assert.deepEqual(
        db.search.findIntegrationCandidates("the AND or (a) * + -", 5),
        [],
        "stopwords and one-character noise must not create a query",
      );

      const adversarial = db.search.findIntegrationCandidates(
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
    const noteId = db.notes.addNote(
      "Embedded",
      `${dir}/embedded.md`,
      null,
      "text",
    );
    const embedding = Array.from(
      { length: config.embed.dimensions },
      (_, index) => index === 0 ? 1 : 0,
    );

    db.search.upsertEmbedding(noteId, embedding);

    assert.deepEqual(db.search.getEmbedding(noteId), embedding);
  });
});

dbTest(
  "embedding requests apply retrieval tasks and the configured dimensions",
  async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(Response.json({
          data: [{ embedding: Array(config.embed.dimensions).fill(0) }],
        }));
      };
      const endpoint = "https://provider.example/v1";
      const nomic = "nomic-embed-text-v2-moe:latest";
      await DB.embedText("Page text", endpoint, "secret", nomic, "document");
      await DB.embedText("Search text", endpoint, "secret", nomic, "query");
      await DB.embedText(
        "Generic text",
        endpoint,
        "secret",
        "embedding-model",
        "document",
      );

      assert.deepEqual(bodies, [
        {
          model: nomic,
          input: "search_document: Page text",
          dimensions: config.embed.dimensions,
        },
        {
          model: nomic,
          input: "search_query: Search text",
          dimensions: config.embed.dimensions,
        },
        {
          model: "embedding-model",
          input: "Generic text",
          dimensions: config.embed.dimensions,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

dbTest("embedding requests preserve explicit caller cancellation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const controller = new AbortController();
    const request = DB.embedText(
      "cancelled embedding",
      "https://provider.example/v1",
      "secret",
      "embedding-model",
      "document",
      controller.signal,
    );
    controller.abort();
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

dbTest(
  "hybrid search prioritises literal matches and survives embedding failure",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      await withTempDb(async (db, dir) => {
        const exactId = db.notes.addNote(
          "Plane Limitations",
          `${dir}/plane-limitations.md`,
          null,
          "text",
        );
        const relatedId = db.notes.addNote(
          "Agent Flow Beta Status",
          `${dir}/agent-flow.md`,
          null,
          "text",
        );
        db.notes.indexNote(
          exactId,
          "Plane Limitations",
          "Plane has several operational constraints.",
        );
        db.notes.indexNote(
          relatedId,
          "Agent Flow Beta Status",
          "A flexible feature remains limited during beta.",
        );

        const queryEmbedding = Array(config.embed.dimensions).fill(0);
        queryEmbedding[0] = 1;
        const exactEmbedding = Array(config.embed.dimensions).fill(0);
        exactEmbedding[0] = 0.8;
        exactEmbedding[1] = 0.6;
        db.search.upsertEmbedding(exactId, exactEmbedding);
        db.search.upsertEmbedding(relatedId, queryEmbedding);

        globalThis.fetch = () =>
          Promise.resolve(Response.json({
            data: [{ embedding: queryEmbedding }],
          }));
        const hybrid = await db.search.search(
          "Plane limitations",
          "https://embed.example.test/v1",
          "secret",
          "embed",
        );
        assert.equal(hybrid[0].id, exactId);
        assert.equal(hybrid[0].matchType, "both");

        globalThis.fetch = () => Promise.reject(new Error("offline"));
        const fallback = await db.search.search(
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
