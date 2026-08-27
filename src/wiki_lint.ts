import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { parseJsonResponse, structuredChatCompletion } from "./llm.ts";
import type { WikiQueryPage } from "./query.ts";
import { parseWikiPage, type WikiPage } from "./wiki.ts";
import { DEFAULT_WIKI_SCHEMA, promptWithWikiSchema } from "./wiki_schema.ts";

export type WikiLintSeverity = "error" | "warning" | "info";

export interface WikiLintIssue {
  code:
    | "duplicate_title"
    | "unreadable_page"
    | "legacy_format"
    | "missing_provenance"
    | "broken_link"
    | "orphan_page"
    | "recorded_contradiction";
  severity: WikiLintSeverity;
  pageId: number;
  pageTitle: string;
  message: string;
  relatedTitle?: string;
}

export interface WikiLintReport {
  generatedAt: string;
  pageCount: number;
  sourceCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: WikiLintIssue[];
}

export interface WikiLintAnalysisFinding {
  kind: "contradiction" | "stale_claim" | "missing_connection" | "data_gap";
  severity: "warning" | "info";
  summary: string;
  pageIds: number[];
  recommendation: string;
}

export interface WikiLintAnalysis {
  findings: WikiLintAnalysisFinding[];
}

interface ParsedNote {
  id: number;
  title: string;
  page?: WikiPage;
}

const SEVERITY_ORDER: Record<WikiLintSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const ANALYSIS_PROMPT =
  `You perform a read-only health review of a compiled knowledge wiki.

Use only the supplied wiki pages and deterministic lint report. Identify meaningful contradictions, claims that appear superseded or stale, missing cross-page connections, and important evidence gaps. Preserve uncertainty. Do not propose factual corrections from outside knowledge.

Every finding must cite one or more supplied numeric page IDs. Return at most 20 high-value findings. Return an empty findings array when the supplied evidence does not support a finding.

Respond with ONLY JSON:
{"findings":[{"kind":"contradiction|stale_claim|missing_connection|data_gap","severity":"warning|info","summary":"...","page_ids":[1,2],"recommendation":"..."}]}`;

function normalisedTitle(title: string): string {
  return title.toLocaleLowerCase("en-GB");
}

export async function lintWiki(
  db: DB,
  now: Date = new Date(),
): Promise<WikiLintReport> {
  const notes = db.getAllNotes();
  const issues: WikiLintIssue[] = [];
  const parsedNotes: ParsedNote[] = [];
  const idsByTitle = new Map<string, number[]>();
  const allTitles = new Set<string>();
  const sourceIds = new Set<number>();

  for (const note of notes) {
    const key = normalisedTitle(note.title);
    allTitles.add(key);
    const ids = idsByTitle.get(key) ?? [];
    ids.push(note.id);
    idsByTitle.set(key, ids);

    const provenance = db.getSourceProvenanceForNote(note.id);
    for (const source of provenance) sourceIds.add(source.id);
    if (provenance.length === 0) {
      issues.push({
        code: "missing_provenance",
        severity: "warning",
        pageId: note.id,
        pageTitle: note.title,
        message: "Page has no immutable source provenance.",
      });
    }
    if (provenance.some((source) => source.action === "contradict")) {
      issues.push({
        code: "recorded_contradiction",
        severity: "info",
        pageId: note.id,
        pageTitle: note.title,
        message:
          "Page has source provenance recorded as contradictory evidence.",
      });
    }

    let markdown: string;
    try {
      markdown = await Deno.readTextFile(note.file_path);
    } catch {
      issues.push({
        code: "unreadable_page",
        severity: "error",
        pageId: note.id,
        pageTitle: note.title,
        message: "Registered Markdown file cannot be read.",
      });
      parsedNotes.push({ id: note.id, title: note.title });
      continue;
    }
    try {
      parsedNotes.push({
        id: note.id,
        title: note.title,
        page: parseWikiPage(markdown),
      });
    } catch {
      issues.push({
        code: "legacy_format",
        severity: "warning",
        pageId: note.id,
        pageTitle: note.title,
        message: "Page is not in the current compiler-managed wiki format.",
      });
      parsedNotes.push({ id: note.id, title: note.title });
    }
  }

  for (const [title, ids] of idsByTitle) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const note = notes.find((candidate) => candidate.id === id)!;
      issues.push({
        code: "duplicate_title",
        severity: "error",
        pageId: id,
        pageTitle: note.title,
        relatedTitle: title,
        message: `Multiple pages share the title "${note.title}".`,
      });
    }
  }

  const inbound = new Map<string, number>();
  for (const note of parsedNotes) {
    if (!note.page) continue;
    for (const link of note.page.links) {
      const target = normalisedTitle(link);
      if (!allTitles.has(target)) {
        issues.push({
          code: "broken_link",
          severity: "error",
          pageId: note.id,
          pageTitle: note.title,
          relatedTitle: link,
          message: `Wiki link target "${link}" does not exist.`,
        });
        continue;
      }
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }

  const compilerPages = parsedNotes.filter((note) => note.page);
  if (compilerPages.length > 1) {
    for (const note of compilerPages) {
      if ((inbound.get(normalisedTitle(note.title)) ?? 0) > 0) continue;
      issues.push({
        code: "orphan_page",
        severity: "warning",
        pageId: note.id,
        pageTitle: note.title,
        message: "Page has no inbound wiki links.",
      });
    }
  }

  issues.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.pageTitle.localeCompare(right.pageTitle, "en-GB", {
      sensitivity: "base",
    }) || left.code.localeCompare(right.code)
  );
  return {
    generatedAt: now.toISOString(),
    pageCount: notes.length,
    sourceCount: sourceIds.size,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    infoCount: issues.filter((issue) => issue.severity === "info").length,
    issues,
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(
  value: unknown,
  context: string,
  maxLength = 1_000,
): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${context} must contain 1-${maxLength} characters`);
  }
  return text;
}

export function validateWikiLintAnalysis(
  value: unknown,
  pages: WikiQueryPage[],
): WikiLintAnalysis {
  const analysis = asRecord(value, "Wiki lint analysis");
  if (!Array.isArray(analysis.findings) || analysis.findings.length > 20) {
    throw new Error(
      "Wiki lint analysis.findings must contain at most 20 items",
    );
  }
  const allowedIds = new Set(pages.map((page) => page.id));
  const kinds = new Set([
    "contradiction",
    "stale_claim",
    "missing_connection",
    "data_gap",
  ]);
  return {
    findings: analysis.findings.map((value, index) => {
      const finding = asRecord(value, `Wiki lint analysis.findings[${index}]`);
      if (typeof finding.kind !== "string" || !kinds.has(finding.kind)) {
        throw new Error(
          `Wiki lint analysis.findings[${index}].kind is invalid`,
        );
      }
      if (finding.severity !== "warning" && finding.severity !== "info") {
        throw new Error(
          `Wiki lint analysis.findings[${index}].severity is invalid`,
        );
      }
      if (!Array.isArray(finding.page_ids) || finding.page_ids.length === 0) {
        throw new Error(
          `Wiki lint analysis.findings[${index}].page_ids must be non-empty`,
        );
      }
      const pageIds = [
        ...new Set(finding.page_ids.map((id) => {
          if (!Number.isSafeInteger(id) || !allowedIds.has(id as number)) {
            throw new Error(
              `Wiki lint analysis.findings[${index}] cites an unknown page`,
            );
          }
          return id as number;
        })),
      ];
      return {
        kind: finding.kind as WikiLintAnalysisFinding["kind"],
        severity: finding.severity,
        summary: boundedText(
          finding.summary,
          `Wiki lint analysis.findings[${index}].summary`,
        ),
        pageIds,
        recommendation: boundedText(
          finding.recommendation,
          `Wiki lint analysis.findings[${index}].recommendation`,
        ),
      };
    }),
  };
}

export async function analyseWikiHealth(
  report: WikiLintReport,
  pages: WikiQueryPage[],
  apiBase: string,
  apiKey: string,
  model: string,
  schema: string = DEFAULT_WIKI_SCHEMA,
): Promise<WikiLintAnalysis> {
  if (pages.length === 0 || pages.length > 12) {
    throw new Error("Wiki health analysis requires 1-12 context pages");
  }
  return await structuredChatCompletion(
    "Wiki lint analysis",
    apiBase,
    apiKey,
    model,
    promptWithWikiSchema(ANALYSIS_PROMPT, schema),
    JSON.stringify({
      report: { ...report, issues: report.issues.slice(0, 100) },
      pages,
    }),
    {
      temperature: 0.1,
      maxTokens: Math.max(config.llm.maxTokens, 2_000),
      jsonMode: true,
    },
    (content) =>
      validateWikiLintAnalysis(
        parseJsonResponse(content, "Wiki lint analysis"),
        pages,
      ),
  );
}
