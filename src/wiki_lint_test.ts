import assert from "node:assert/strict";

import { DB } from "./db.ts";
import { renderWikiPage } from "./wiki.ts";
import {
  analyzeWikiHealth,
  lintWiki,
  validateWikiLintAnalysis,
  type WikiLintReport,
} from "./wiki_lint.ts";

Deno.test({
  name: "wiki lint reports structural and provenance health deterministically",
  permissions: "inherit",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "synthesis-wiki-lint-" });
    const db = new DB(`${dir}/synthesis.db`);
    try {
      const hash = "f".repeat(64);
      const sourceId = db.addSource(
        hash,
        "Clinical evidence source",
        "https://example.test/evidence",
        "text",
        `${dir}/source.txt`,
        "Evidence summary.",
      );
      const addPage = async (
        title: string,
        links: string[],
        filename = `${title.toLowerCase().replaceAll(" ", "-")}.md`,
      ) => {
        const path = `${dir}/${filename}`;
        await Deno.writeTextFile(
          path,
          renderWikiPage({
            title,
            type: "concept",
            body: `${title} body.`,
            tags: ["evidence"],
            links,
          }, [{ title: "Clinical evidence source", contentHash: hash }]),
        );
        return db.addNote(title, path, null, "text");
      };

      const treatment = await addPage(
        "Treatment effect",
        ["Confidence assessment", "Missing endpoint"],
      );
      const confidence = await addPage(
        "Confidence assessment",
        ["Treatment effect"],
      );
      const orphan = await addPage("Orphan finding", []);
      const duplicatePath = `${dir}/orphan-finding-duplicate.md`;
      await Deno.writeTextFile(
        duplicatePath,
        "# orphan finding\n\nLegacy body.\n",
      );
      db.addNote("orphan finding", duplicatePath, null, "text");
      db.addNote("Unreadable page", `${dir}/missing.md`, null, "text");

      db.attachNoteSource(treatment, sourceId, "contradict");
      db.attachNoteSource(confidence, sourceId, "new");

      const report = await lintWiki(
        db,
        new Date("2026-08-02T12:00:00.000Z"),
      );
      assert.deepEqual(
        {
          generatedAt: report.generatedAt,
          pageCount: report.pageCount,
          sourceCount: report.sourceCount,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          infoCount: report.infoCount,
        },
        {
          generatedAt: "2026-08-02T12:00:00.000Z",
          pageCount: 5,
          sourceCount: 1,
          errorCount: 4,
          warningCount: 5,
          infoCount: 1,
        },
      );
      assert.deepEqual(
        report.issues.map((issue) => issue.code),
        [
          "duplicate_title",
          "duplicate_title",
          "broken_link",
          "unreadable_page",
          "legacy_format",
          "missing_provenance",
          "missing_provenance",
          "orphan_page",
          "missing_provenance",
          "recorded_contradiction",
        ],
      );
      const broken = report.issues.find((issue) =>
        issue.code === "broken_link"
      );
      assert.equal(broken?.pageId, treatment);
      assert.equal(broken?.relatedTitle, "Missing endpoint");
      assert.equal(
        report.issues.find((issue) => issue.code === "orphan_page")?.pageId,
        orphan,
      );
    } finally {
      db.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("LLM wiki health findings must cite supplied pages", async () => {
  const pages = [
    { id: 2, title: "Treatment effect", content: "Evidence is mixed." },
    { id: 3, title: "Trial evidence", content: "Studies disagree." },
  ];
  const valid = {
    findings: [{
      kind: "contradiction",
      severity: "warning",
      summary: "The pages report differing treatment effects.",
      page_ids: [2, 2, 3],
      recommendation: "Review the underlying study populations.",
    }],
  };
  assert.deepEqual(validateWikiLintAnalysis(valid, pages).findings[0].pageIds, [
    2,
    3,
  ]);
  assert.deepEqual(validateWikiLintAnalysis({ findings: [] }, pages), {
    findings: [],
  });
  assert.throws(
    () =>
      validateWikiLintAnalysis({
        findings: [{ ...valid.findings[0], page_ids: [99] }],
      }, pages),
    /unknown page/,
  );

  const report: WikiLintReport = {
    generatedAt: "2026-08-02T12:00:00.000Z",
    pageCount: 2,
    sourceCount: 2,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    issues: [],
  };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (_input, init) => {
      assert.doesNotMatch(String(init?.body), /secret-key/);
      return Promise.resolve(Response.json({
        choices: [{ message: { content: JSON.stringify(valid) } }],
      }));
    };
    const result = await analyzeWikiHealth(
      report,
      pages,
      "https://api.example.test/v1",
      "secret-key",
      "analysis-model",
    );
    assert.equal(result.findings[0].kind, "contradiction");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
