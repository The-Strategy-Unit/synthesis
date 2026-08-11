import assert from "node:assert/strict";

import { config } from "./config.ts";
import { DB } from "./db.ts";
import { processSingleSource, stageSingleSource } from "./orchestrate.ts";
import { renderWikiPage } from "./wiki.ts";

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
        { length: config.embed.dimensions },
        (_, index) => index === 0 ? 1 : 0,
      );
      const failedEmbedding = Array.from(
        { length: config.embed.dimensions },
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
                  type: "concept",
                  body: "Candidate one.",
                  tags: ["one"],
                  links: ["Supporting context"],
                },
                {
                  title: "Supporting context",
                  type: "concept",
                  body: "Candidate two.",
                  tags: ["two"],
                  links: ["Shared title"],
                },
              ],
            }));
          case 1:
            return Promise.resolve(jsonModelResponse({
              summary: "A concise first-source summary.",
              notes: [
                {
                  title: "Shared title",
                  type: "concept",
                  body: "Final note one.",
                  tags: ["one"],
                  links: ["Supporting context"],
                },
                {
                  title: "Supporting context",
                  type: "concept",
                  body: "Final note two.",
                  tags: ["two"],
                  links: ["Shared title"],
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
                type: "concept",
                body: "Final note one gains verified detail.",
                tags: ["one"],
                links: [],
              }],
            }));
          case 5:
            return Promise.resolve(jsonModelResponse({
              summary: "A concise second-source summary.",
              notes: [{
                title: "Shared title update",
                type: "concept",
                body: "Final note one gains verified detail.",
                tags: ["one"],
                links: [],
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
            return Promise.resolve(jsonModelResponse({
              body: "Merged body includes the verified detail.",
            }));
          case 9:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Shared title retry",
                type: "concept",
                body: "A failed update must never remain indexed.",
                tags: ["retry"],
                links: [],
              }],
            }));
          case 10:
            return Promise.resolve(jsonModelResponse({
              summary: "A retryable third-source summary.",
              notes: [{
                title: "Shared title retry",
                type: "concept",
                body: "A failed update must never remain indexed.",
                tags: ["retry"],
                links: [],
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
            return Promise.resolve(jsonModelResponse({
              body: "Failed rewrite text must be rolled back.",
            }));
          case 13:
            return Promise.resolve(
              Response.json({ data: [{ embedding: failedEmbedding }] }),
            );
          case 14:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Unsafe title update",
                type: "concept",
                body: "A rewrite must not change the canonical page title.",
                tags: ["unsafe"],
                links: [],
              }],
            }));
          case 15:
            return Promise.resolve(jsonModelResponse({
              summary: "A source that produces an unsafe title rewrite.",
              notes: [{
                title: "Unsafe title update",
                type: "concept",
                body: "A rewrite must not change the canonical page title.",
                tags: ["unsafe"],
                links: [],
              }],
            }));
          case 16:
            assert.ok(state.mergeTargetId);
            return Promise.resolve(jsonModelResponse({
              decisions: [{
                action: "merge",
                existing_id: state.mergeTargetId,
              }],
            }));
          case 17:
            return Promise.resolve(jsonModelResponse({
              title: "Changed canonical title",
              type: "synthesis",
              body: "The compiler keeps the accepted canonical identity.",
            }));
          case 18:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Shared title malformed rewrite",
                type: "concept",
                body: "A malformed rewrite must be rejected before embedding.",
                tags: ["unsafe"],
                links: [],
              }],
            }));
          case 19:
            return Promise.resolve(jsonModelResponse({
              summary: "A source that produces malformed wiki Markdown.",
              notes: [{
                title: "Shared title malformed rewrite",
                type: "concept",
                body: "A malformed rewrite must be rejected before embedding.",
                tags: ["unsafe"],
                links: [],
              }],
            }));
          case 20:
            assert.ok(state.mergeTargetId);
            return Promise.resolve(jsonModelResponse({
              decisions: [{
                action: "merge",
                existing_id: state.mergeTargetId,
              }],
            }));
          case 21:
          case 22:
            return Promise.resolve(jsonModelResponse({
              body: "Malformed body.\n\n## Sources\n\n- invented",
            }));
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
        [`${dir}/notes/shared-title.md`, `${dir}/notes/supporting-context.md`],
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
        "Key findings: Shared title — Final note one. Supporting context — Final note two.\n",
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
      const targetBefore = await Deno.readTextFile(target.file_path);
      const unaffectedBefore = await Deno.readTextFile(unaffected.file_path);
      assert.match(targetBefore, /^type: concept$/m);
      assert.match(targetBefore, /- \[\[Supporting context\]\]/);
      assert.match(unaffectedBefore, /- \[\[Shared title\]\]/);
      const indexPath = `${dir}/notes/index.md`;
      const logPath = `${dir}/notes/log.md`;
      const indexAfterFirst = await Deno.readTextFile(indexPath);
      assert.match(indexAfterFirst, /## Concepts/);
      assert.match(indexAfterFirst, /\[\[Shared title\]\] — Final note one\./);
      assert.match(
        indexAfterFirst,
        /\[\[Supporting context\]\] — Final note two\./,
      );
      const logAfterFirst = await Deno.readTextFile(logPath);
      assert.equal(occurrences(logAfterFirst, "ingest | First source"), 1);
      assert.match(logAfterFirst, /create concept: \[\[Shared title\]\]/);
      assert.match(
        logAfterFirst,
        /create concept: \[\[Supporting context\]\]/,
      );

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
      assert.equal(
        await Deno.readTextFile(logPath),
        logAfterFirst,
        "repeat ingestion must not append a duplicate log entry",
      );

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
      const logAfterSecond = await Deno.readTextFile(logPath);
      assert.equal(occurrences(logAfterSecond, "ingest | First source"), 1);
      assert.equal(occurrences(logAfterSecond, "ingest | Second source"), 1);
      assert.match(logAfterSecond, /update concept: \[\[Shared title\]\]/);

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
        existing_page: {
          title: string;
          type: string;
          body: string;
          tags: string[];
          links: string[];
        };
        new_pages: Array<{
          title: string;
          type: string;
          body: string;
          tags: string[];
          links: string[];
        }>;
      };
      assert.equal(rewriteInput.action, "merge");
      assert.deepEqual(rewriteInput.existing_page, {
        title: "Shared title",
        type: "concept",
        body: "Final note one.",
        tags: ["one"],
        links: ["Supporting context"],
      });
      assert.deepEqual(rewriteInput.new_pages, [{
        title: "Shared title update",
        type: "concept",
        body: "Final note one gains verified detail.",
        tags: ["one"],
        links: [],
      }]);

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
        "Key findings: Shared title update — Final note one gains verified detail.\n",
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
      const indexBeforeFailure = await Deno.readTextFile(indexPath);
      const logBeforeFailure = await Deno.readTextFile(logPath);

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
      assert.equal(await Deno.readTextFile(indexPath), indexBeforeFailure);
      assert.equal(await Deno.readTextFile(logPath), logBeforeFailure);

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
        "Key findings: Shared title retry — A failed update must never remain indexed.\n",
      );
      const thirdSourceRecord = db.getSourceByHash(thirdHash);
      assert.ok(thirdSourceRecord, "the source record must remain for retry");
      assert.equal(thirdSourceRecord.file_path, `${thirdSourceDir}/source.txt`);
      assert.equal(
        thirdSourceRecord.summary,
        "Key findings: Shared title retry — A failed update must never remain indexed.",
      );
      assert.deepEqual(db.getNotesForSource(thirdSourceRecord.id), []);

      const activeDb = db;
      const assertWikiUnchanged = async () => {
        assert.equal(await Deno.readTextFile(target.file_path), mergedMarkdown);
        assert.deepEqual(
          activeDb.getEmbedding(target.id),
          embeddingBeforeFailure,
        );
        const indexed = activeDb.findIntegrationCandidates(
          "verified detail",
          10,
        )
          .find((candidate) => candidate.id === target.id);
        assert.ok(indexed);
        assert.equal(indexed.body, indexedBeforeFailure.body);
        assert.equal(await Deno.readTextFile(indexPath), indexBeforeFailure);
        assert.equal(await Deno.readTextFile(logPath), logBeforeFailure);
      };

      const renamedSource = {
        transcript: "A source that triggers an identity-changing rewrite.",
        sourceUrl: "https://youtube.com/watch?v=source-renamed",
        title: "Renamed rewrite source",
      };
      const renamed = await stageSingleSource(
        db,
        renamedSource,
        false,
        () => {},
      );
      assert.equal(renamed.kind, "proposal");
      if (renamed.kind !== "proposal") return;
      assert.equal(renamed.proposal.changes[0].page.title, "Shared title");
      assert.equal(renamed.proposal.changes[0].page.type, "concept");
      assert.doesNotMatch(
        renamed.proposal.changes[0].markdown,
        /Changed canonical title/,
      );
      assert.match(
        renamed.proposal.changes[0].markdown,
        /compiler keeps the accepted canonical identity/,
      );
      assert.equal(
        requests.length,
        18,
        "staging must not request an embedding",
      );
      await assertWikiUnchanged();
      const renamedSourceRecord = db.getSourceByHash(
        await sha256(renamedSource.transcript),
      );
      assert.ok(renamedSourceRecord);
      assert.deepEqual(db.getNotesForSource(renamedSourceRecord.id), []);

      const malformedSource = {
        transcript: "A source that triggers a malformed Markdown rewrite.",
        sourceUrl: "https://youtube.com/watch?v=source-malformed",
        title: "Malformed rewrite source",
      };
      await assert.rejects(
        processSingleSource(db, malformedSource, false, () => {}),
        /Wiki page rewrite was invalid after one retry: Wiki page\.body must not contain compiler-managed Related or Sources headings/,
      );
      assert.equal(
        requests.length,
        23,
        "malformed page must fail before embed",
      );
      await assertWikiUnchanged();
      const malformedSourceRecord = db.getSourceByHash(
        await sha256(malformedSource.transcript),
      );
      assert.ok(malformedSourceRecord);
      assert.deepEqual(db.getNotesForSource(malformedSourceRecord.id), []);
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db?.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "a multi-page ingest is fully validated before any page changes",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-orchestrate-atomic-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);
    const requests: Array<Record<string, unknown>> = [];
    const targetIds: { alpha?: number; beta?: number } = {};
    const embedding = Array.from(
      { length: config.embed.dimensions },
      (_, index) => index === 0 ? 1 : 0,
    );

    try {
      config.vaultDir = dir;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      globalThis.fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const index = requests.push(body) - 1;
        switch (index) {
          case 0:
          case 1:
            return Promise.resolve(jsonModelResponse(
              index === 0
                ? {
                  items: [
                    {
                      title: "Alpha topic",
                      type: "concept",
                      body: "Original alpha evidence.",
                      tags: ["alpha"],
                      links: ["Beta topic"],
                    },
                    {
                      title: "Beta topic",
                      type: "concept",
                      body: "Original beta evidence.",
                      tags: ["beta"],
                      links: ["Alpha topic"],
                    },
                  ],
                }
                : {
                  summary: "Original alpha and beta evidence.",
                  notes: [
                    {
                      title: "Alpha topic",
                      type: "concept",
                      body: "Original alpha evidence.",
                      tags: ["alpha"],
                      links: ["Beta topic"],
                    },
                    {
                      title: "Beta topic",
                      type: "concept",
                      body: "Original beta evidence.",
                      tags: ["beta"],
                      links: ["Alpha topic"],
                    },
                  ],
                },
            ));
          case 2:
          case 3:
            return Promise.resolve(Response.json({ data: [{ embedding }] }));
          case 4:
          case 5:
            return Promise.resolve(jsonModelResponse(
              index === 4
                ? {
                  items: [
                    {
                      title: "Alpha topic update",
                      type: "concept",
                      body: "Proposed alpha update.",
                      tags: ["alpha"],
                      links: ["Beta topic update"],
                    },
                    {
                      title: "Beta topic update",
                      type: "concept",
                      body: "Proposed beta update.",
                      tags: ["beta"],
                      links: ["Alpha topic update"],
                    },
                  ],
                }
                : {
                  summary: "Proposed updates to alpha and beta evidence.",
                  notes: [
                    {
                      title: "Alpha topic update",
                      type: "concept",
                      body: "Proposed alpha update.",
                      tags: ["alpha"],
                      links: ["Beta topic update"],
                    },
                    {
                      title: "Beta topic update",
                      type: "concept",
                      body: "Proposed beta update.",
                      tags: ["beta"],
                      links: ["Alpha topic update"],
                    },
                  ],
                },
            ));
          case 6:
            assert.ok(targetIds.alpha);
            assert.ok(targetIds.beta);
            return Promise.resolve(jsonModelResponse({
              decisions: [
                { action: "merge", existing_id: targetIds.alpha },
                { action: "merge", existing_id: targetIds.beta },
              ],
            }));
          case 7:
            return Promise.resolve(jsonModelResponse({
              body: "Alpha was rewritten in memory only.",
            }));
          case 8:
          case 9:
            return Promise.resolve(jsonModelResponse({
              body: "Malformed body.\n\n## Related\n\n- [[Alpha topic]]",
            }));
          default:
            throw new Error(`Unexpected model request ${index + 1}`);
        }
      };

      const initial = await processSingleSource(
        db,
        {
          transcript: "Original source containing alpha and beta evidence.",
          sourceUrl: "",
          title: "Original source",
        },
        true,
        () => {},
      );
      assert.equal(initial.notes.length, 2);
      targetIds.alpha = initial.notes.find((note) =>
        note.title === "Alpha topic"
      )?.id;
      targetIds.beta = initial.notes.find((note) => note.title === "Beta topic")
        ?.id;
      assert.ok(targetIds.alpha);
      assert.ok(targetIds.beta);

      const alpha = db.getNote(targetIds.alpha);
      const beta = db.getNote(targetIds.beta);
      assert.ok(alpha);
      assert.ok(beta);
      const alphaBefore = await Deno.readTextFile(alpha.file_path);
      const betaBefore = await Deno.readTextFile(beta.file_path);
      const alphaEmbeddingBefore = db.getEmbedding(alpha.id);
      const betaEmbeddingBefore = db.getEmbedding(beta.id);
      const indexBefore = await Deno.readTextFile(`${dir}/notes/index.md`);
      const logBefore = await Deno.readTextFile(`${dir}/notes/log.md`);

      const failingSource = {
        transcript: "A second source proposes updates to alpha and beta.",
        sourceUrl: "",
        title: "Invalid multi-page source",
      };
      await assert.rejects(
        processSingleSource(db, failingSource, true, () => {}),
        /Wiki page rewrite was invalid after one retry: Wiki page\.body must not contain compiler-managed Related or Sources headings/,
      );
      assert.equal(
        requests.length,
        10,
        "all rewrites must validate before update embeddings are requested",
      );
      assert.equal(await Deno.readTextFile(alpha.file_path), alphaBefore);
      assert.equal(await Deno.readTextFile(beta.file_path), betaBefore);
      assert.deepEqual(db.getEmbedding(alpha.id), alphaEmbeddingBefore);
      assert.deepEqual(db.getEmbedding(beta.id), betaEmbeddingBefore);
      assert.equal(
        await Deno.readTextFile(`${dir}/notes/index.md`),
        indexBefore,
      );
      assert.equal(await Deno.readTextFile(`${dir}/notes/log.md`), logBefore);
      assert.deepEqual(
        db.findIntegrationCandidates("rewritten in memory", 10),
        [],
      );
      const failedSourceRecord = db.getSourceByHash(
        await sha256(failingSource.transcript),
      );
      assert.ok(failedSourceRecord);
      assert.deepEqual(db.getNotesForSource(failedSourceRecord.id), []);
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "same-target updates use one rewrite call with visible progress",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    const dir = await Deno.makeTempDir({
      prefix: "synthesis-grouped-rewrite-test-",
    });
    const db = new DB(`${dir}/synthesis.db`);

    try {
      config.vaultDir = dir;
      await Deno.mkdir(`${dir}/notes`, { recursive: true });
      const existingHash = "a".repeat(64);
      const existingSourceId = db.addSource(
        existingHash,
        "Existing source",
        null,
        "text",
        `${dir}/existing-source.txt`,
        "Existing evidence.",
      );
      const existingPath = `${dir}/notes/operational-threshold.md`;
      await Deno.writeTextFile(
        existingPath,
        renderWikiPage({
          title: "Operational threshold",
          type: "concept",
          body: "The operational threshold was 5 units.",
          tags: ["operations"],
          links: [],
        }, [{
          title: "Existing source",
          contentHash: existingHash,
        }]),
      );
      const existingId = db.addNote(
        "Operational threshold",
        existingPath,
        null,
        "text",
      );
      db.indexNote(
        existingId,
        "Operational threshold",
        "The operational threshold was 5 units.",
      );
      db.attachNoteSource(existingId, existingSourceId, "new");

      const requests: Array<Record<string, unknown>> = [];
      globalThis.fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const index = requests.push(body) - 1;
        switch (index) {
          case 0:
            return Promise.resolve(jsonModelResponse({
              items: [{
                title: "Operational threshold context",
                type: "concept",
                body:
                  "The operational threshold applies to the audited workflow.",
                tags: ["operations"],
                links: [],
              }, {
                title: "Operational threshold correction",
                type: "concept",
                body:
                  "A correction updates the operational threshold to 6.5 units rather than 5 units.",
                tags: ["correction"],
                links: [],
              }],
            }));
          case 1:
            return Promise.resolve(jsonModelResponse({
              notes: [{
                title: "Operational threshold context",
                type: "concept",
                body:
                  "The operational threshold applies to the audited workflow.",
                tags: ["operations"],
                links: [],
              }, {
                title: "Operational threshold correction",
                type: "concept",
                body:
                  "A correction updates the operational threshold to 6.5 units rather than 5 units.",
                tags: ["correction"],
                links: [],
              }],
            }));
          case 2:
            return Promise.resolve(jsonModelResponse({
              decisions: [{ action: "merge", existing_id: existingId }, {
                action: "contradict",
                existing_id: existingId,
              }],
            }));
          case 3:
            return Promise.resolve(jsonModelResponse({
              body:
                "The audited workflow previously used 5 units; corrected evidence updates the threshold to 6.5 units.",
            }));
          default:
            throw new Error(`Unexpected model request ${index + 1}`);
        }
      };

      const progress: unknown[] = [];
      const staged = await stageSingleSource(
        db,
        {
          transcript: "A source with two updates for one operational page.",
          sourceUrl: "",
          title: "Grouped update source",
        },
        true,
        (stage, data) => {
          if (stage === "rewriting") progress.push(data);
        },
      );
      assert.equal(staged.kind, "proposal");
      if (staged.kind !== "proposal") return;
      assert.equal(requests.length, 4);
      assert.equal(staged.proposal.changes.length, 1);
      assert.equal(staged.proposal.changes[0].action, "contradict");
      assert.deepEqual(progress, [{
        current: 1,
        total: 1,
        title: "Operational threshold",
      }]);
      const messages = requests[3].messages as Array<{ content: string }>;
      const rewrite = JSON.parse(messages[1].content) as {
        action: string;
        new_pages: unknown[];
      };
      assert.equal(rewrite.action, "contradict");
      assert.equal(rewrite.new_pages.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
