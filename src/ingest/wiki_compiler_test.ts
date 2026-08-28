import assert from "node:assert/strict";

import { config } from "../app/config.ts";
import { DB } from "../catalogue/db.ts";
import { processSingleSource } from "./orchestrate.ts";
import { parseWikiPage } from "../wiki/wiki.ts";

function chatResponse(content: unknown): Response {
  return Response.json({
    choices: [{
      message: {
        content: typeof content === "string"
          ? content
          : JSON.stringify(content),
      },
    }],
  });
}

async function contentHash(text: string): Promise<string> {
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
  name: "three clinical sources compound into a cited contradiction-aware wiki",
  permissions: "inherit",
  fn: async () => {
    const originalFetch = globalThis.fetch;
    const originalVaultDir = config.vaultDir;
    const vault = await Deno.makeTempDir({ prefix: "synthesis-golden-wiki-" });
    const db = new DB(`${vault}/synthesis.db`);
    const requests: Array<Record<string, unknown>> = [];
    let treatmentPageId: number | undefined;

    const embedding = Array.from(
      { length: config.embed.dimensions },
      (_, index) => index === 0 ? 1 : 0,
    );
    try {
      config.vaultDir = vault;
      await Deno.mkdir(`${vault}/notes`, { recursive: true });
      globalThis.fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const index = requests.push(body) - 1;
        switch (index) {
          case 0:
            return Promise.resolve(chatResponse({
              items: [{
                title: "Treatment effect",
                type: "concept",
                body:
                  "The initial study reports that treatment reduces symptoms.",
                tags: ["treatment", "evidence"],
                links: [],
              }],
            }));
          case 1:
            return Promise.resolve(chatResponse({
              summary: "An initial study reports a treatment benefit.",
              notes: [{
                title: "Treatment effect",
                type: "concept",
                body:
                  "The initial study reports that treatment reduces symptoms.",
                tags: ["treatment", "evidence"],
                links: [],
              }],
            }));
          case 2:
          case 7:
          case 8:
          case 13:
            return Promise.resolve(Response.json({ data: [{ embedding }] }));
          case 3:
            return Promise.resolve(chatResponse({
              items: [
                {
                  title: "Treatment benefit evidence",
                  type: "concept",
                  body:
                    "A larger follow-up study also reports symptom reduction.",
                  tags: ["treatment", "replication"],
                  links: ["Confidence assessment"],
                },
                {
                  title: "Confidence assessment",
                  type: "synthesis",
                  body:
                    "Two studies reporting benefit increase confidence in the treatment effect.",
                  tags: ["evidence", "confidence"],
                  links: ["Treatment benefit evidence"],
                },
              ],
            }));
          case 4:
            return Promise.resolve(chatResponse({
              summary:
                "A larger follow-up supports the initial treatment result.",
              notes: [
                {
                  title: "Treatment benefit evidence",
                  type: "concept",
                  body:
                    "A larger follow-up study also reports symptom reduction.",
                  tags: ["treatment", "replication"],
                  links: ["Confidence assessment"],
                },
                {
                  title: "Confidence assessment",
                  type: "synthesis",
                  body:
                    "Two studies reporting benefit increase confidence in the treatment effect.",
                  tags: ["evidence", "confidence"],
                  links: ["Treatment benefit evidence"],
                },
              ],
            }));
          case 5:
            assert.ok(treatmentPageId);
            return Promise.resolve(chatResponse({
              decisions: [
                { action: "merge", existing_id: treatmentPageId },
                { action: "new" },
              ],
            }));
          case 6:
            return Promise.resolve(chatResponse({
              body:
                "The initial and larger follow-up studies both report that treatment reduces symptoms.",
            }));
          case 9:
            return Promise.resolve(chatResponse({
              items: [{
                title: "Treatment effect conflict",
                type: "concept",
                body:
                  "A separate controlled study reports no measurable symptom reduction.",
                tags: ["treatment", "conflict"],
                links: [],
              }],
            }));
          case 10:
            return Promise.resolve(chatResponse({
              summary:
                "A controlled study conflicts with the earlier treatment findings.",
              notes: [{
                title: "Treatment effect conflict",
                type: "concept",
                body:
                  "A separate controlled study reports no measurable symptom reduction.",
                tags: ["treatment", "conflict"],
                links: [],
              }],
            }));
          case 11:
            assert.ok(treatmentPageId);
            return Promise.resolve(chatResponse({
              decisions: [{
                action: "contradict",
                existing_id: treatmentPageId,
              }],
            }));
          case 12:
            return Promise.resolve(chatResponse({
              body:
                "The initial and larger follow-up studies report symptom reduction. However, a separate controlled study reports no measurable reduction, so the evidence is conflicting.",
            }));
          default:
            throw new Error(`Unexpected model request ${index + 1}`);
        }
      };

      const baseline = {
        transcript: "Baseline clinical trial transcript.",
        sourceUrl: "https://example.test/baseline",
        title: "Baseline clinical trial",
      };
      const support = {
        transcript: "Larger supportive clinical study transcript.",
        sourceUrl: "https://example.test/support",
        title: "Supportive clinical study",
      };
      const conflict = {
        transcript: "Conflicting controlled clinical study transcript.",
        sourceUrl: "https://example.test/conflict",
        title: "Conflicting clinical study",
      };

      const first = await processSingleSource(db, baseline, false, () => {});
      assert.deepEqual(
        [first.newCount, first.mergeCount, first.contradictCount],
        [1, 0, 0],
      );
      treatmentPageId = first.notes[0].id;

      const second = await processSingleSource(db, support, false, () => {});
      assert.deepEqual(
        [second.newCount, second.mergeCount, second.contradictCount],
        [1, 1, 0],
      );

      const third = await processSingleSource(db, conflict, false, () => {});
      assert.deepEqual(
        [third.newCount, third.mergeCount, third.contradictCount],
        [0, 0, 1],
      );
      assert.equal(db.notes.getAllNotes().length, 2);

      const treatment = db.notes.getNote(treatmentPageId);
      assert.ok(treatment);
      const treatmentMarkdown = await Deno.readTextFile(treatment.file_path);
      const parsedTreatment = parseWikiPage(treatmentMarkdown);
      assert.match(parsedTreatment.body, /evidence is conflicting/);
      assert.deepEqual(parsedTreatment.links, ["Confidence assessment"]);

      const confidence = db.notes.getAllNotes().find((note) =>
        note.title === "Confidence assessment"
      );
      assert.ok(confidence);
      const parsedConfidence = parseWikiPage(
        await Deno.readTextFile(confidence.file_path),
      );
      assert.deepEqual(parsedConfidence.links, ["Treatment effect"]);

      for (const source of [baseline, support, conflict]) {
        assert.equal(
          occurrences(
            treatmentMarkdown,
            `synthesis-source:${await contentHash(source.transcript)}`,
          ),
          1,
        );
      }

      const index = await Deno.readTextFile(`${vault}/notes/index.md`);
      assert.match(index, /\[\[Treatment effect\]\].*evidence is conflicting/);
      assert.match(index, /## Syntheses/);
      assert.match(index, /\[\[Confidence assessment\]\]/);

      const logBeforeDuplicate = await Deno.readTextFile(
        `${vault}/notes/log.md`,
      );
      assert.match(
        logBeforeDuplicate,
        /create concept: \[\[Treatment effect\]\]/,
      );
      assert.match(
        logBeforeDuplicate,
        /update concept: \[\[Treatment effect\]\]/,
      );
      assert.match(
        logBeforeDuplicate,
        /create synthesis: \[\[Confidence assessment\]\]/,
      );
      assert.match(
        logBeforeDuplicate,
        /contradict concept: \[\[Treatment effect\]\]/,
      );

      const requestCount = requests.length;
      const duplicate = await processSingleSource(
        db,
        conflict,
        false,
        () => {},
      );
      assert.deepEqual(duplicate.touchedIds, []);
      assert.equal(requests.length, requestCount);
      assert.equal(
        await Deno.readTextFile(`${vault}/notes/log.md`),
        logBeforeDuplicate,
      );
    } finally {
      globalThis.fetch = originalFetch;
      config.vaultDir = originalVaultDir;
      db.close();
      await Deno.remove(vault, { recursive: true });
    }
  },
});
