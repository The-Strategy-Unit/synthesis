import { render as renderMarkdown } from "gfm";

import { config } from "../../app/config.ts";
import { LlmServiceError } from "../../provider/llm.ts";
import { answerWiki, validateWikiAnswer } from "../../wiki/query.ts";
import { buildWikiGraph, getRelatedWikiPages } from "../../wiki/wiki_graph.ts";
import { analyseWikiHealth, lintWiki } from "../../wiki/wiki_lint.ts";
import { ensureWikiSchema } from "../../wiki/wiki_schema.ts";
import {
  saveWikiSynthesis,
  WikiPageExistsError,
} from "../../wiki/wiki_store.ts";
import {
  findClaimCitations,
  findSourceReferencePages,
  parseWikiPage,
} from "../../wiki/wiki.ts";
import type { ApiRoute } from "../route_context.ts";
import {
  ApiError,
  errorResponse,
  hybridSearch,
  json,
  keywordSearch,
  loadWikiPages,
  logFailure,
  orderSearchResults,
  readJson,
  requiredString,
  requireIngester,
  retrieveWikiContext,
  semanticSearch,
  wikiLintContext,
} from "../support.ts";

export const handleWikiRoutes: ApiRoute = async (context) => {
  const {
    db,
    identity,
    method,
    path,
    req,
    requestId,
    resolveProviders,
    semanticSearchGate,
    url,
  } = context;

  if (path === "/api/lint" && method === "GET") {
    return json(await lintWiki(db));
  }
  if (path === "/api/lint/analyze" && method === "POST") {
    try {
      semanticSearchGate.check(identity);
      const report = await lintWiki(db);
      const lintContext = await wikiLintContext(
        db,
        report.issues.map((issue) => issue.pageId),
      );
      if (lintContext.length === 0) {
        throw new ApiError(
          422,
          "NO_WIKI_CONTEXT",
          "No readable wiki pages were found",
        );
      }
      const providers = await resolveProviders();
      const schema = await ensureWikiSchema();
      return json(
        await analyseWikiHealth(
          report,
          lintContext,
          providers.llm.apiBase,
          providers.llm.apiKey,
          providers.llm.consolidateModel,
          schema,
        ),
      );
    } catch (error) {
      if (error instanceof ApiError || error instanceof LlmServiceError) {
        throw error;
      }
      logFailure(requestId, "Wiki health analysis", error);
      return errorResponse(
        500,
        "LINT_ANALYSIS_FAILED",
        "Wiki health analysis failed",
        requestId,
      );
    }
  }
  if (path === "/api/notes" && method === "GET") {
    return json({
      notes: db.notes.getAllNotes().map(({ id, title, source_url }) => ({
        id,
        title,
        source_url,
      })),
    });
  }
  if (path === "/api/sources" && method === "GET") {
    return json({
      sources: db.sources.getAllSources().map((source) => ({
        id: source.id,
        title: source.title,
        sourceUrl: source.source_url,
        sourceType: source.source_type,
        summary: source.summary,
        createdAt: source.created_at,
        pageCount: db.sources.getNotesForSource(source.id).length,
      })),
    });
  }
  if (path.startsWith("/api/sources/") && method === "GET") {
    const id = Number(path.split("/")[3]);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new ApiError(400, "INVALID_INPUT", "Invalid source ID");
    }
    const source = db.sources.getSource(id);
    if (!source) throw new ApiError(404, "NOT_FOUND", "Not found");
    return json({
      id: source.id,
      title: source.title,
      sourceUrl: source.source_url,
      sourceType: source.source_type,
      summary: source.summary,
      createdAt: source.created_at,
      pages: await Promise.all(
        db.sources.getNotesForSource(id).map(async (note) => {
          let sourcePages: number[] | undefined;
          try {
            sourcePages = findSourceReferencePages(
              await Deno.readTextFile(note.file_path),
              source.content_hash,
            );
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          return {
            id: note.id,
            title: note.title,
            action: note.action,
            ...(sourcePages ? { sourcePages } : {}),
          };
        }),
      ),
    });
  }
  if (path.startsWith("/api/notes/") && method === "GET") {
    const id = Number(path.split("/")[3]);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new ApiError(400, "INVALID_INPUT", "Invalid note ID");
    }
    const note = db.notes.getNote(id);
    if (!note) throw new ApiError(404, "NOT_FOUND", "Not found");
    const content = await Deno.readTextFile(note.file_path);
    const page = parseWikiPage(content);
    const provenance = db.sources.getSourceProvenanceForNote(id);
    const sourceIdsByHash = new Map(
      provenance.map((source) => [source.content_hash, source.id]),
    );
    const sources = provenance.map((source) => {
      const sourcePages = findSourceReferencePages(
        content,
        source.content_hash,
      );
      return {
        id: source.id,
        title: source.title,
        sourceUrl: source.source_url,
        sourceType: source.source_type,
        summary: source.summary,
        action: source.action,
        ...(sourcePages ? { sourcePages } : {}),
      };
    });
    const claims = findClaimCitations(content).map((claim, index) => {
      const sourceIds = claim.sourceHashes.map((hash) =>
        sourceIdsByHash.get(hash)
      );
      if (sourceIds.some((sourceId) => sourceId === undefined)) {
        throw new Error(
          `Wiki claim ${index + 1} has uncatalogued source provenance`,
        );
      }
      return {
        text: claim.text,
        sourceIds: sourceIds as number[],
      };
    });
    return json({
      id: note.id,
      title: note.title,
      source_url: note.source_url,
      source_type: note.source_type,
      content,
      bodyHtml: renderMarkdown(page.body),
      sources,
      claims,
      related: await getRelatedWikiPages(db, id),
    });
  }

  if (path === "/api/query" && method === "POST") {
    const body = await readJson(req);
    const question = requiredString(
      body.question,
      "question",
      config.security.maxSearchChars,
    );
    try {
      semanticSearchGate.check(identity);
      const providers = await resolveProviders();
      const queryContext = await retrieveWikiContext(db, question, providers);
      if (queryContext.length === 0) {
        throw new ApiError(
          422,
          "NO_WIKI_CONTEXT",
          "No relevant wiki pages were found",
        );
      }
      const result = await answerWiki(
        question,
        queryContext,
        providers.llm.apiBase,
        providers.llm.apiKey,
        providers.llm.consolidateModel,
        await ensureWikiSchema(),
      );
      const titles = new Map(
        queryContext.map((page) => [page.id, page.title]),
      );
      return json({
        answer: result.answer,
        citations: result.citations.map((id) => ({
          id,
          title: titles.get(id),
        })),
        suggestedPage: result.suggestedPage,
      });
    } catch (error) {
      if (error instanceof ApiError || error instanceof LlmServiceError) {
        throw error;
      }
      logFailure(requestId, "Wiki query", error);
      return errorResponse(
        500,
        "QUERY_FAILED",
        "Wiki query failed",
        requestId,
      );
    }
  }

  if (path === "/api/query/save" && method === "POST") {
    requireIngester(identity);
    const body = await readJson(req);
    const question = requiredString(
      body.question,
      "question",
      config.security.maxSearchChars,
    );
    if (!Array.isArray(body.citations)) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "'citations' must be an array",
      );
    }
    const citationIds = body.citations.map((value) => {
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new ApiError(
          400,
          "INVALID_INPUT",
          "Citation IDs must be positive integers",
        );
      }
      return value as number;
    });
    const queryContext = await loadWikiPages(db, citationIds);
    let result;
    try {
      result = validateWikiAnswer({
        answer: body.answer,
        citations: citationIds,
        suggested_page: body.suggestedPage,
      }, queryContext);
    } catch {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "The reviewed wiki answer is invalid",
      );
    }
    try {
      const saved = await saveWikiSynthesis(
        db,
        result.suggestedPage,
        result.citations,
        await resolveProviders(),
        question,
      );
      return json({ saved }, 201);
    } catch (error) {
      if (error instanceof WikiPageExistsError) {
        return json({
          error: error.message,
          code: "PAGE_EXISTS",
          existingNoteId: error.noteId,
          requestId,
        }, 409);
      }
      logFailure(requestId, "Wiki query save", error);
      return errorResponse(
        500,
        "QUERY_SAVE_FAILED",
        "Wiki answer could not be saved",
        requestId,
      );
    }
  }

  if (path === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (q.length > config.security.maxSearchChars) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Search query is too long",
      );
    }
    if (!q) return json({ results: [], query: "" });
    const mode = url.searchParams.get("mode") ?? "hybrid";
    if (!["hybrid", "keyword", "semantic"].includes(mode)) {
      throw new ApiError(400, "INVALID_INPUT", "Invalid search mode");
    }
    try {
      const results = mode === "keyword"
        ? keywordSearch(db, q)
        : mode === "semantic"
        ? await semanticSearch(
          db,
          q,
          identity,
          resolveProviders,
          semanticSearchGate,
        )
        : await hybridSearch(
          db,
          q,
          identity,
          resolveProviders,
          semanticSearchGate,
        );
      return json({ results: orderSearchResults(results), query: q });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logFailure(requestId, "Search", error);
      return errorResponse(
        500,
        "SEARCH_FAILED",
        "Search failed",
        requestId,
      );
    }
  }

  if (path === "/api/graph" && method === "GET") {
    return json(await buildWikiGraph(db));
  }
};
