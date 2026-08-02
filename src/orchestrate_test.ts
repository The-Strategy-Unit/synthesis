import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import { processSingleSource } from "./orchestrate.ts";

class FailingAttachDb extends DB {
  failAttach = false;

  override attachNoteSource(
    noteId: number,
    sourceId: number,
    action: string,
  ): void {
    if (this.failAttach) {
      throw new Error("forced provenance attachment failure");
    }
    super.attachNoteSource(noteId, sourceId, action);
  }
}

function modelResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

function jsonModelResponse(content: unknown): Response {
  return modelResponse(JSON.stringify(content));
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

Deno.test({
  name: "sources create, merge, retain provenance, and remain idempotent",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-orchestrate-test-",
    });
    let db: FailingAttachDb | undefined;

    try {
      config.vaultDir = dir;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      db = new FailingAttachDb(`${dir}/synthesis.db`);

      const embedding = Array.from(
        { length: 4096 },
        (_, index) => index === 0 ? 1 : 0,
      );
      const failedEmbedding = Array.from(
        { length: 4096 },
        (_, index) => index === 1 ? 1 : 0,
      );
      const requests: Array<{ url: string; body: Record<string, unknown> }> =
        [];
      const state: { mergeTargetId?: number } = {};
      globalThis.fetch = (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const index = requests.push({ url, body }) - 1;

        switch (index) {
          case 0:
            return Promise.resolve(jsonModelResponse({
              items: [
                {
                  title: "Shared title",
                  body: "Candidate one.",
                  tags: ["one"],
                },
                {
                  title: "Shared title",
                  body: "Candidate two.",
                  tags: ["two"],
                },
              ],
            }));
          case 1:
            return Promise.resolve(jsonModelResponse({
              summary: "A concise first-source summary.",
              notes: [
                {
                  title: "Shared title",
                  body: "Final note one.",
                  tags: ["one"],
                },
                {
                  title: "Shared title",
                  body: "Final note two.",
                  tags: ["two"],
                },
              ],
            }));
          case 2:
          case 3:
          case 8:
            return Promise.resolve(Response.json({ data: [{ embedding }] }));
          case 4:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Shared title update",
                body: "Final note one gains verified detail.",
                tags: ["one"],
              }],
            }));
          case 5:
            return Promise.resolve(jsonModelResponse({
              summary: "A concise second-source summary.",
              notes: [{
                title: "Shared title update",
                body: "Final note one gains verified detail.",
                tags: ["one"],
              }],
            }));
          case 6:
            assert.ok(state.mergeTargetId);
            return Promise.resolve(jsonModelResponse({
              decisions: [{
                action: "merge",
                existing_id: state.mergeTargetId,
              }],
            }));
          case 7:
            return Promise.resolve(modelResponse(
              "# Shared title\n\nMerged body includes the verified detail.",
            ));
          case 9:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Shared title retry",
                body: "A failed update must never remain indexed.",
                tags: ["retry"],
              }],
            }));
          case 10:
            return Promise.resolve(jsonModelResponse({
              summary: "A retryable third-source summary.",
              notes: [{
                title: "Shared title retry",
                body: "A failed update must never remain indexed.",
                tags: ["retry"],
              }],
            }));
          case 11:
            assert.ok(state.mergeTargetId);
            return Promise.resolve(jsonModelResponse({
              decisions: [{
                action: "merge",
                existing_id: state.mergeTargetId,
              }],
            }));
          case 12:
            return Promise.resolve(modelResponse(
              "# Shared title\n\nFailed rewrite text must be rolled back.",
            ));
          case 13:
            return Promise.resolve(
              Response.json({ data: [{ embedding: failedEmbedding }] }),
            );
          default:
            throw new Error(`Unexpected model request ${index + 1}`);
        }
      };

      const firstSource = {
        transcript: "The immutable first source transcript.",
        sourceUrl: "https://youtube.com/watch?v=source-one",
        title: "First source",
      };
      const first = await processSingleSource(
        db,
        firstSource,
        false,
        () => {},
      );
      assert.deepEqual(
        {
          newCount: first.newCount,
          mergeCount: first.mergeCount,
          contradictCount: first.contradictCount,
        },
        { newCount: 2, mergeCount: 0, contradictCount: 0 },
      );
      assert.equal(first.notes.length, 2);
      assert.equal(first.touchedIds.length, 2);
      assert.equal(requests.length, 4);

      const notesAfterFirst = db.getAllNotes();
      assert.equal(notesAfterFirst.length, 2);
      assert.equal(
        new Set(notesAfterFirst.map((note) => note.file_path)).size,
        2,
      );
      assert.deepEqual(
        notesAfterFirst.map((note) => note.file_path).sort(),
        [`${dir}/notes/shared-title-2.md`, `${dir}/notes/shared-title.md`],
      );

      const firstHash = await sha256(firstSource.transcript);
      const firstSourceDir = `${dir}/sources/${firstHash}`;
      assert.equal(
        await Deno.readTextFile(`${firstSourceDir}/source.txt`),
        firstSource.transcript,
      );
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(`${firstSourceDir}/meta.json`)),
        {
          contentHash: firstHash,
          title: firstSource.title,
          sourceUrl: firstSource.sourceUrl,
          sourceType: "youtube",
        },
      );
      assert.equal(
        await Deno.readTextFile(`${firstSourceDir}/summary.md`),
        "A concise first-source summary.\n",
      );
      const firstSourceRecord = db.getSourceByHash(firstHash);
      assert.ok(firstSourceRecord);
      assert.deepEqual(
        db.getNotesForSource(firstSourceRecord.id).map((note) => note.action),
        ["new", "new"],
      );

      const target = db.getNote(first.notes[0].id);
      const unaffected = db.getNote(first.notes[1].id);
      assert.ok(target);
      assert.ok(unaffected);
      state.mergeTargetId = target.id;
      const unaffectedBefore = await Deno.readTextFile(unaffected.file_path);

      const repeated = await processSingleSource(
        db,
        firstSource,
        false,
        () => {},
      );
      assert.deepEqual(
        {
          newCount: repeated.newCount,
          mergeCount: repeated.mergeCount,
          contradictCount: repeated.contradictCount,
          touchedIds: repeated.touchedIds,
        },
        { newCount: 0, mergeCount: 0, contradictCount: 0, touchedIds: [] },
      );
      assert.equal(
        requests.length,
        4,
        "repeat ingestion must not call a model",
      );
      assert.equal(db.getAllNotes().length, 2);

      const secondSource = {
        transcript: "A distinct source adds verified detail to final note one.",
        sourceUrl: "https://youtube.com/watch?v=source-two",
        title: "Second source",
      };
      const second = await processSingleSource(
        db,
        secondSource,
        false,
        () => {},
      );
      assert.deepEqual(
        {
          newCount: second.newCount,
          mergeCount: second.mergeCount,
          contradictCount: second.contradictCount,
          touchedIds: second.touchedIds,
        },
        {
          newCount: 0,
          mergeCount: 1,
          contradictCount: 0,
          touchedIds: [target.id],
        },
      );
      assert.equal(db.getAllNotes().length, 2);
      assert.equal(requests.length, 9);

      assert.deepEqual(
        requests.map((request) => request.body.model),
        [
          config.llm.extractModel,
          config.llm.consolidateModel,
          config.embed.model,
          config.embed.model,
          config.llm.extractModel,
          config.llm.consolidateModel,
          config.llm.integrateModel,
          config.llm.rewriteModel,
          config.embed.model,
        ],
      );
      assert.deepEqual(
        requests.map((request) =>
          request.url.endsWith("/embeddings") ? "embed" : "chat"
        ),
        [
          "chat",
          "chat",
          "embed",
          "embed",
          "chat",
          "chat",
          "chat",
          "chat",
          "embed",
        ],
      );

      const integrationMessages = requests[6].body.messages as Array<{
        content: string;
      }>;
      const integrationInput = JSON.parse(integrationMessages[1].content) as {
        existing_notes: Array<{ id: number; title: string; body?: string }>;
      };
      const retrievedTarget = integrationInput.existing_notes.find((note) =>
        note.id === target.id
      );
      assert.ok(retrievedTarget, "FTS must retrieve the real merge target");
      assert.equal(retrievedTarget.body, "Final note one.");

      const rewriteMessages = requests[7].body.messages as Array<{
        content: string;
      }>;
      const rewriteInput = JSON.parse(rewriteMessages[1].content) as {
        action: string;
        existing_markdown: string;
        new_insight: string;
      };
      assert.equal(rewriteInput.action, "merge");
      assert.match(rewriteInput.existing_markdown, /Final note one\./);
      assert.equal(
        rewriteInput.new_insight,
        "Final note one gains verified detail.",
      );

      const secondHash = await sha256(secondSource.transcript);
      const secondSourceDir = `${dir}/sources/${secondHash}`;
      assert.equal(
        await Deno.readTextFile(`${secondSourceDir}/source.txt`),
        secondSource.transcript,
      );
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(`${secondSourceDir}/meta.json`)),
        {
          contentHash: secondHash,
          title: secondSource.title,
          sourceUrl: secondSource.sourceUrl,
          sourceType: "youtube",
        },
      );
      assert.equal(
        await Deno.readTextFile(`${secondSourceDir}/summary.md`),
        "A concise second-source summary.\n",
      );
      const secondSourceRecord = db.getSourceByHash(secondHash);
      assert.ok(secondSourceRecord);
      assert.deepEqual(
        db.getNotesForSource(secondSourceRecord.id).map((note) => ({
          id: note.id,
          action: note.action,
        })),
        [{ id: target.id, action: "merge" }],
      );

      const mergedMarkdown = await Deno.readTextFile(target.file_path);
      assert.match(
        mergedMarkdown,
        /Merged body includes the verified detail\./,
      );
      assert.equal(
        occurrences(mergedMarkdown, `synthesis-source:${firstHash}`),
        1,
      );
      assert.equal(
        occurrences(mergedMarkdown, `synthesis-source:${secondHash}`),
        1,
      );
      assert.equal(
        await Deno.readTextFile(unaffected.file_path),
        unaffectedBefore,
        "the non-target note must not be rewritten",
      );

      const embeddingBeforeFailure = db.getEmbedding(target.id);
      assert.ok(embeddingBeforeFailure);
      const indexedBeforeFailure = db.findIntegrationCandidates(
        "verified detail",
        10,
      ).find((candidate) => candidate.id === target.id);
      assert.ok(indexedBeforeFailure);
      const firstAttachmentsBefore = db.getNotesForSource(firstSourceRecord.id)
        .map((note) => ({ id: note.id, action: note.action }));
      const secondAttachmentsBefore = db.getNotesForSource(
        secondSourceRecord.id,
      )
        .map((note) => ({ id: note.id, action: note.action }));
      const noteFilesBefore = [];
      for await (const entry of Deno.readDir(`${dir}/notes`)) {
        if (entry.isFile) noteFilesBefore.push(entry.name);
      }
      noteFilesBefore.sort();

      const thirdSource = {
        transcript: "A third source exercises transactional retry behavior.",
        sourceUrl: "https://youtube.com/watch?v=source-three",
        title: "Third source",
      };
      db.failAttach = true;
      try {
        await assert.rejects(
          processSingleSource(db, thirdSource, false, () => {}),
          /forced provenance attachment failure/,
        );
      } finally {
        db.failAttach = false;
      }

      assert.equal(requests.length, 14);
      assert.deepEqual(
        requests.map((request) => request.body.model),
        [
          config.llm.extractModel,
          config.llm.consolidateModel,
          config.embed.model,
          config.embed.model,
          config.llm.extractModel,
          config.llm.consolidateModel,
          config.llm.integrateModel,
          config.llm.rewriteModel,
          config.embed.model,
          config.llm.extractModel,
          config.llm.consolidateModel,
          config.llm.integrateModel,
          config.llm.rewriteModel,
          config.embed.model,
        ],
      );
      assert.deepEqual(
        requests.map((request) =>
          request.url.endsWith("/embeddings") ? "embed" : "chat"
        ),
        [
          "chat",
          "chat",
          "embed",
          "embed",
          "chat",
          "chat",
          "chat",
          "chat",
          "embed",
          "chat",
          "chat",
          "chat",
          "chat",
          "embed",
        ],
      );

      assert.equal(
        await Deno.readTextFile(target.file_path),
        mergedMarkdown,
        "the note file must be restored byte-for-byte",
      );
      assert.deepEqual(db.getEmbedding(target.id), embeddingBeforeFailure);
      const indexedAfterFailure = db.findIntegrationCandidates(
        "verified detail",
        10,
      ).find((candidate) => candidate.id === target.id);
      assert.ok(indexedAfterFailure);
      assert.equal(indexedAfterFailure.body, indexedBeforeFailure.body);
      assert.doesNotMatch(indexedAfterFailure.body, /Failed rewrite text/);
      assert.deepEqual(db.findIntegrationCandidates("failed update", 10), []);
      assert.deepEqual(
        db.getNotesForSource(firstSourceRecord.id).map((note) => ({
          id: note.id,
          action: note.action,
        })),
        firstAttachmentsBefore,
      );
      assert.deepEqual(
        db.getNotesForSource(secondSourceRecord.id).map((note) => ({
          id: note.id,
          action: note.action,
        })),
        secondAttachmentsBefore,
      );
      assert.equal(db.getAllNotes().length, 2);
      const noteFilesAfter = [];
      for await (const entry of Deno.readDir(`${dir}/notes`)) {
        if (entry.isFile) noteFilesAfter.push(entry.name);
      }
      noteFilesAfter.sort();
      assert.deepEqual(noteFilesAfter, noteFilesBefore);

      const thirdHash = await sha256(thirdSource.transcript);
      const thirdSourceDir = `${dir}/sources/${thirdHash}`;
      assert.equal(
        await Deno.readTextFile(`${thirdSourceDir}/source.txt`),
        thirdSource.transcript,
      );
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(`${thirdSourceDir}/meta.json`)),
        {
          contentHash: thirdHash,
          title: thirdSource.title,
          sourceUrl: thirdSource.sourceUrl,
          sourceType: "youtube",
        },
      );
      assert.equal(
        await Deno.readTextFile(`${thirdSourceDir}/summary.md`),
        "A retryable third-source summary.\n",
      );
      const thirdSourceRecord = db.getSourceByHash(thirdHash);
      assert.ok(thirdSourceRecord, "the source record must remain for retry");
      assert.equal(thirdSourceRecord.file_path, `${thirdSourceDir}/source.txt`);
      assert.equal(
        thirdSourceRecord.summary,
        "A retryable third-source summary.",
      );
      assert.deepEqual(db.getNotesForSource(thirdSourceRecord.id), []);
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db?.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
