import { config } from "../app/config.ts";
import type { DB } from "../catalogue/db.ts";
import {
  getPlaylistVideos,
  type IngestResult,
  ingestYouTube,
  normaliseYouTubePlaylistInput,
  normaliseYouTubeVideoInput,
} from "../ingest/ingest.ts";
import { ingestLocalFile, LocalFileError } from "../ingest/local_file.ts";
import type { IngestProposalApproval } from "../ingest/ingest_proposal.ts";
import {
  type AppliedIngestResult,
  approveIngestProposal,
  stageSingleSource,
} from "../ingest/orchestrate.ts";
import {
  type ActiveProviders,
  providerMode,
} from "../provider/provider_runtime.ts";
import { LlmServiceError } from "../provider/llm.ts";
import { errMsg } from "../shared/utils.ts";
import type { IngestReviewAudit } from "../vault/ingest_history.ts";
import { generateDiscoveries } from "../wiki/discovery.ts";
import { ensureWikiSchema } from "../wiki/wiki_schema.ts";
import {
  ApiError,
  asProposalApiError,
  logFailure,
  type ProviderResolver,
  readBodyBytes,
  requiredString,
  responseHeaders,
} from "./core.ts";

type IngestDependencies = {
  ingestYouTube: typeof ingestYouTube;
};

type SseData = Record<string, unknown>;

type IngestSend = (stage: string, data?: unknown) => void;

type IngestRun = (
  send: IngestSend,
  signal: AbortSignal,
) => Promise<Array<{ id: number; title: string }>>;

class IngestCancelledError extends Error {
  constructor() {
    super("Ingest stopped");
  }
}

function ensureIngestActive(signal: AbortSignal): void {
  if (signal.aborted) throw new IngestCancelledError();
}

function asSseData(data: unknown): SseData {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as SseData
    : {};
}

async function readLocalFile(req: Request): Promise<IngestResult> {
  const bytes = await readBodyBytes(
    req,
    config.security.maxUploadBytes,
    "File upload body required",
  );
  const contentType = req.headers.get("Content-Type")!;
  let form: FormData;
  try {
    form = await new Response(bytes.slice().buffer, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new ApiError(400, "INVALID_MULTIPART", "Invalid file upload body");
  }
  const keys = [...new Set(form.keys())];
  if (keys.some((key) => key !== "file" && key !== "title")) {
    throw new ApiError(400, "INVALID_INPUT", "Unexpected upload field");
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) {
    throw new ApiError(400, "INVALID_INPUT", "Provide exactly one file");
  }
  const titles = form.getAll("title");
  if (titles.length > 1 || titles.some((value) => typeof value !== "string")) {
    throw new ApiError(400, "INVALID_INPUT", "Provide at most one title");
  }
  const titleValue = titles[0] as string | undefined;
  const title = titleValue?.trim()
    ? requiredString(titleValue, "title", config.security.maxTitleChars)
    : undefined;
  const file = files[0];
  if (file.size === 0) {
    throw new ApiError(400, "INVALID_FILE", "The selected file is empty");
  }
  if (file.size > config.security.maxUploadBytes) {
    throw new ApiError(413, "INPUT_TOO_LARGE", "Uploaded file is too large");
  }
  try {
    return await ingestLocalFile({
      fileName: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      title,
    });
  } catch (error) {
    if (!(error instanceof LocalFileError)) throw error;
    const status = error.code === "INPUT_TOO_LARGE" ||
        error.code === "PDF_TOO_MANY_PAGES"
      ? 413
      : error.code === "PDF_NO_TEXT" || error.code === "PDF_ENCRYPTED" ||
          error.code === "PDF_PARSE_FAILED"
      ? 422
      : 400;
    throw new ApiError(status, error.code, error.message);
  }
}

function readSource(body: Record<string, unknown>): {
  kind: "text" | "youtube";
  value: string;
} {
  const hasUrl = body.url !== undefined;
  const hasText = body.text !== undefined;
  if (hasUrl === hasText) {
    throw new ApiError(400, "INVALID_INPUT", "Provide either 'url' or 'text'");
  }
  const value = requiredString(
    hasUrl ? body.url : body.text,
    hasUrl ? "url" : "text",
    config.security.maxPastedTextChars,
  );
  if (!hasUrl) return { kind: "text", value };
  try {
    return { kind: "youtube", value: normaliseYouTubeVideoInput(value) };
  } catch (error) {
    throw new ApiError(400, "INVALID_YOUTUBE_INPUT", errMsg(error));
  }
}

function normalisePlaylistInput(value: string): string {
  try {
    return normaliseYouTubePlaylistInput(value);
  } catch (error) {
    throw new ApiError(400, "INVALID_YOUTUBE_INPUT", errMsg(error));
  }
}

async function processAndStage(
  db: DB,
  ingested: IngestResult,
  textInput: boolean,
  send: (stage: string, data?: unknown) => void,
  resolveProviders: ProviderResolver,
  signal?: AbortSignal,
) {
  send("extracting");
  const result = await stageSingleSource(
    db,
    ingested,
    textInput,
    send,
    await resolveProviders(),
    signal,
  );
  if (result.kind === "already-applied") return result.result.notes;
  const counts = { new: 0, merge: 0, contradict: 0 };
  for (const change of result.proposal.changes) counts[change.action]++;
  send("proposal", { proposal: result.proposal, ...counts });
  return [];
}

async function approveProposalAndRefresh(
  db: DB,
  requestId: string,
  proposalId: number,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders,
  options: {
    approval?: IngestProposalApproval;
    review?: IngestReviewAudit;
    generateSynthesis?: boolean;
    refreshLinks?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<AppliedIngestResult> {
  const result = await approveIngestProposal(
    db,
    proposalId,
    send,
    providers,
    options.approval ?? {},
    options.review ?? { reviewMode: "manual" },
    options.signal,
  );
  send("integrated", {
    new: result.newCount,
    merge: result.mergeCount,
    contradict: result.contradictCount,
  });
  if (options.refreshLinks !== false) {
    send("linking");
    const semanticIndex = db.search.semanticIndexStatus();
    if (semanticIndex.complete) db.search.computeLinksFor(result.touchedIds);
    else {
      db.search.clearLinks();
      send("warning", {
        error:
          `Accepted changes were saved, but the semantic index is incomplete (${semanticIndex.embedded}/${semanticIndex.total} pages)`,
        requestId,
      });
    }
  }
  if (options.generateSynthesis === false) return result;
  try {
    const synthesis = await generateDiscoveries(
      db,
      result.touchedIds,
      providers.llm.apiBase,
      providers.llm.apiKey,
      providers.llm.consolidateModel,
      await ensureWikiSchema(),
      { scope: "seeded", signal: options.signal },
    );
    send("discoveries", synthesis);
  } catch (error) {
    if (options.signal?.aborted || error instanceof IngestCancelledError) {
      throw error;
    }
    logFailure(requestId, "Discovery generation", error);
    send("warning", {
      error: "Approved changes were saved, but discovery generation failed",
      requestId,
    });
  }
  return result;
}

function ingestStream(
  requestId: string,
  release: () => void,
  requestSignal: AbortSignal,
  run: IngestRun,
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  if (requestSignal.aborted) abort();
  const stream = new ReadableStream({
    start(controller) {
      void runStream(controller);
    },
    cancel() {
      abort();
    },
  });

  async function runStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    const signal = abortController.signal;
    const send = (stage: string, data?: unknown) => {
      ensureIngestActive(signal);
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ stage, ...asSseData(data) })}\n\n`,
          ),
        );
      } catch {
        abort();
        throw new IngestCancelledError();
      }
    };
    try {
      send("ingesting", { title: "Processing source..." });
      send("done", { notes: await run(send, signal) });
    } catch (err) {
      if (signal.aborted || err instanceof IngestCancelledError) return;
      const proposalError = asProposalApiError(err);
      const llmError = err instanceof LlmServiceError;
      const apiError = err instanceof ApiError
        ? err
        : proposalError ?? (llmError
          ? new ApiError(502, "LLM_SERVICE_ERROR", err.message)
          : undefined);
      if (llmError || !apiError) logFailure(requestId, "Ingest", err);
      try {
        send("error", {
          error: apiError?.message ?? "Ingest failed",
          code: apiError?.code ?? "INGEST_FAILED",
          requestId,
        });
      } catch { /* disconnected */ }
    } finally {
      requestSignal.removeEventListener("abort", abort);
      release();
      try {
        controller.close();
      } catch { /* disconnected */ }
    }
  }

  return new Response(stream, {
    headers: responseHeaders("text/event-stream"),
  });
}

function playlistStream(
  db: DB,
  requestId: string,
  release: () => void,
  requestSignal: AbortSignal,
  playlistUrl: string,
  resolveProviders: ProviderResolver,
): Response {
  const run: IngestRun = async (send, signal) => {
    const videoUrls = await getPlaylistVideos(playlistUrl, signal);
    send("ingested", { title: `${videoUrls.length} videos found` });
    const notes: Array<{ id: number; title: string }> = [];
    let failures = 0;
    let successes = 0;
    for (let i = 0; i < videoUrls.length; i++) {
      try {
        ensureIngestActive(signal);
        send("distilling", { title: `Video ${i + 1}/${videoUrls.length}` });
        notes.push(
          ...await processAndStage(
            db,
            await ingestYouTube(videoUrls[i], signal),
            false,
            send,
            resolveProviders,
            signal,
          ),
        );
        successes++;
      } catch (err) {
        if (signal.aborted || err instanceof IngestCancelledError) throw err;
        failures++;
        logFailure(requestId, `Playlist video ${i + 1}`, err);
      }
    }
    if (successes === 0) {
      throw new ApiError(
        502,
        "PLAYLIST_INGEST_FAILED",
        "Every playlist video failed to ingest",
      );
    }
    if (failures) {
      send("warning", {
        error: `${failures} of ${videoUrls.length} playlist videos failed`,
        requestId,
      });
    }
    return notes;
  };
  return ingestStream(requestId, release, requestSignal, run);
}

function trustedBatchStream(
  db: DB,
  requestId: string,
  release: () => void,
  requestSignal: AbortSignal,
  videoUrls: string[],
  resolveProviders: ProviderResolver,
  ingestVideo: typeof ingestYouTube,
): Response {
  const run: IngestRun = async (send, signal) => {
    const batchId = crypto.randomUUID();
    const providers = await resolveProviders();
    send("batch_started", {
      batchId,
      total: videoUrls.length,
      reviewMode: "automatic",
      providerMode: providerMode(providers),
    });
    const notes: Array<{ id: number; title: string }> = [];
    let applied = 0;
    let skipped = 0;
    for (let index = 0; index < videoUrls.length; index++) {
      ensureIngestActive(signal);
      const current = index + 1;
      send("batch_source", {
        batchId,
        current,
        total: videoUrls.length,
        url: videoUrls[index],
      });
      const ingested = await ingestVideo(videoUrls[index], signal);
      send("ingested", {
        batchId,
        current,
        total: videoUrls.length,
        title: ingested.title,
      });
      send("extracting", { batchId, current, total: videoUrls.length });
      const staged = await stageSingleSource(
        db,
        ingested,
        false,
        send,
        providers,
        signal,
      );
      if (staged.kind === "already-applied") {
        skipped++;
        notes.push(...staged.result.notes);
        send("batch_skipped", {
          batchId,
          current,
          total: videoUrls.length,
          title: ingested.title,
          reason: "already-applied",
        });
        continue;
      }

      const counts = { new: 0, merge: 0, contradict: 0 };
      for (const change of staged.proposal.changes) counts[change.action]++;
      send("automatic_proposal", {
        batchId,
        current,
        total: videoUrls.length,
        proposalId: staged.proposal.id,
        title: ingested.title,
        ...counts,
      });
      const result = await approveProposalAndRefresh(
        db,
        requestId,
        staged.proposal.id,
        send,
        providers,
        {
          review: { reviewMode: "automatic", batchId },
          generateSynthesis: false,
          refreshLinks: false,
          signal,
        },
      );
      applied++;
      notes.push(...result.notes);
      send("automatic_applied", {
        batchId,
        current,
        total: videoUrls.length,
        proposalId: staged.proposal.id,
        historyId: result.historyId,
        new: result.newCount,
        merge: result.mergeCount,
        contradict: result.contradictCount,
      });
    }
    if (applied > 0) {
      ensureIngestActive(signal);
      send("linking", { batchId, scope: "vault" });
      const semanticIndex = db.search.semanticIndexStatus();
      if (semanticIndex.complete) db.search.computeLinks(config.link.k);
      else db.search.clearLinks();
    }
    send("synthesizing", {
      batchId,
      scope: "vault",
      pageCount: db.notes.getAllNotes().length,
    });
    try {
      let generation: string | undefined;
      while (true) {
        ensureIngestActive(signal);
        const synthesis = await generateDiscoveries(
          db,
          db.notes.getAllNotes().map((note) => note.id),
          providers.llm.apiBase,
          providers.llm.apiKey,
          providers.llm.consolidateModel,
          await ensureWikiSchema(),
          {
            scope: "vault",
            generation,
            onProgress: ({ current, total, candidateCount, coverage }) => {
              send("synthesis_progress", {
                batchId,
                current,
                total,
                candidateCount,
                coverage,
              });
            },
            signal,
          },
        );
        send("discoveries", { ...synthesis, scope: "vault" });
        if (synthesis.coverage.complete) break;
        generation = synthesis.coverage.generation ?? undefined;
      }
    } catch (error) {
      if (
        signal.aborted || error instanceof IngestCancelledError
      ) throw error;
      logFailure(requestId, "Cross-source synthesis", error);
      send("warning", {
        error: "Trusted sources were saved, but cross-source synthesis failed",
        requestId,
      });
    }
    send("batch_complete", {
      batchId,
      total: videoUrls.length,
      applied,
      skipped,
    });
    return notes;
  };
  return ingestStream(requestId, release, requestSignal, run);
}

export {
  approveProposalAndRefresh,
  ingestStream,
  normalisePlaylistInput,
  playlistStream,
  processAndStage,
  readLocalFile,
  readSource,
  trustedBatchStream,
};
export type { IngestDependencies, IngestSend };
