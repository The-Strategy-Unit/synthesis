import { config } from "../../app/config.ts";
import { ingestText } from "../../ingest/ingest.ts";
import {
  TrustedBatchInputError,
  validateTrustedBatchRequest,
} from "../../ingest/trusted_batch.ts";
import {
  IngestUndoConflictError,
  IngestUndoNotAvailableError,
  undoLastIngest,
} from "../../vault/ingest_undo.ts";
import type { ApiRoute } from "../route_context.ts";
import {
  ApiError,
  ingestStream,
  json,
  normalisePlaylistInput,
  optionalString,
  playlistStream,
  processAndStage,
  readJson,
  readLocalFile,
  readSource,
  requiredString,
  requireIngester,
  trustedBatchStream,
  validateDeclaredSize,
} from "../support.ts";

export const handleIngestRoutes: ApiRoute = async (context) => {
  const {
    db,
    identity,
    ingestDependencies,
    ingestGate,
    method,
    path,
    req,
    requestId,
    resolveProviders,
  } = context;

  if (path === "/api/ingest" && method === "POST") {
    requireIngester(identity);
    const body = await readJson(req);
    const source = readSource(body);
    const textInput = source.kind === "text";
    if (
      textInput && source.value.length >
        config.security.maxPastedTextChars
    ) {
      throw new ApiError(
        413,
        "INPUT_TOO_LARGE",
        "Pasted text is too long",
      );
    }
    const title = optionalString(
      body.title,
      "title",
      config.security.maxTitleChars,
    ) ?? "Pasted text";
    const release = await ingestGate.acquire(identity, req.signal);
    return ingestStream(
      requestId,
      release,
      req.signal,
      async (send, signal) => {
        const ingested = textInput
          ? ingestText(title, source.value)
          : await ingestDependencies.ingestYouTube(source.value, signal);
        send("ingested", { title: ingested.title });
        return await processAndStage(
          db,
          ingested,
          textInput,
          send,
          resolveProviders,
          signal,
        );
      },
    );
  }

  if (path === "/api/ingest/undo" && method === "POST") {
    requireIngester(identity);
    const body = await readJson(req);
    if (body.confirm !== "UNDO") {
      throw new ApiError(
        400,
        "CONFIRMATION_REQUIRED",
        "Set 'confirm' to 'UNDO' to undo the last accepted ingest",
      );
    }
    try {
      return json({ undo: await undoLastIngest(db) });
    } catch (error) {
      if (error instanceof IngestUndoNotAvailableError) {
        throw new ApiError(404, "NOTHING_TO_UNDO", error.message);
      }
      if (error instanceof IngestUndoConflictError) {
        throw new ApiError(409, "UNDO_CONFLICT", error.message);
      }
      throw error;
    }
  }

  if (path === "/api/ingest/batch" && method === "POST") {
    requireIngester(identity);
    let batch;
    try {
      batch = validateTrustedBatchRequest(
        await readJson(req),
        config.ingest.maxTrustedBatchItems,
      );
    } catch (error) {
      if (error instanceof TrustedBatchInputError) {
        throw new ApiError(400, error.code, error.message);
      }
      throw error;
    }
    const release = await ingestGate.acquire(identity, req.signal);
    return trustedBatchStream(
      db,
      requestId,
      release,
      req.signal,
      batch.urls,
      resolveProviders,
      ingestDependencies.ingestYouTube,
    );
  }

  if (path === "/api/ingest/file" && method === "POST") {
    requireIngester(identity);
    validateDeclaredSize(req, config.security.maxUploadBytes);
    const release = await ingestGate.acquire(identity, req.signal);
    return ingestStream(
      requestId,
      release,
      req.signal,
      async (send, signal) => {
        const ingested = await readLocalFile(req);
        send("ingested", {
          title: ingested.title,
          sourceType: ingested.sourceType,
          ...(ingested.pageCount === undefined
            ? {}
            : { pageCount: ingested.pageCount }),
        });
        return await processAndStage(
          db,
          ingested,
          true,
          send,
          resolveProviders,
          signal,
        );
      },
    );
  }

  if (path === "/api/ingest/playlist" && method === "POST") {
    requireIngester(identity);
    if (!config.ingest.playlistEnabled) {
      throw new ApiError(404, "NOT_FOUND", "Not found");
    }
    const body = await readJson(req);
    const playlistUrl = normalisePlaylistInput(
      requiredString(body.url, "url", 2048),
    );
    const release = await ingestGate.acquire(identity, req.signal);
    return playlistStream(
      db,
      requestId,
      release,
      req.signal,
      playlistUrl,
      resolveProviders,
    );
  }
};
