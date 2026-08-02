import assert from "node:assert/strict";

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
        ...Array<number>(4093).fill(0),
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
      { length: 4096 },
      (_, index) => index === 0 ? 1 : 0,
    );

    db.upsertEmbedding(noteId, embedding);

    assert.deepEqual(db.getEmbedding(noteId), embedding);
  });
});
