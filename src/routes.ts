// HTTP routing: the entire `/api/*` table plus static file serving.

import { config } from "./config.ts";
import { errMsg } from "./utils.ts";
import { DB } from "./db.ts";
import {
  getPlaylistVideos,
  ingestText,
  ingestYouTube,
  validateYouTubeUrl,
} from "./ingest.ts";
import { isUrl, processSingleSource } from "./orchestrate.ts";

type SseData = Record<string, unknown>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

class IngestGate {
  private activeIdentity: string | null = null;
  private queue: Array<{
    identity: string;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  }> = [];
  private day = "";
  private globalJobs = 0;
  private userJobs = new Map<string, number>();

  acquire(identity: string, signal: AbortSignal): Promise<() => void> {
    this.resetDay();
    if (
      this.activeIdentity === identity ||
      this.queue.some((entry) => entry.identity === identity)
    ) {
      throw new ApiError(429, "BUSY", "An ingest job is already pending", 30);
    }
    if (
      (this.userJobs.get(identity) ?? 0) >= config.security.perUserDailyJobs
    ) {
      throw new ApiError(
        429,
        "QUOTA_EXCEEDED",
        "Daily ingest quota reached",
        3600,
      );
    }
    if (this.globalJobs >= config.security.globalDailyJobs) {
      throw new ApiError(
        429,
        "QUOTA_EXCEEDED",
        "Daily ingest quota reached",
        3600,
      );
    }
    if (
      this.activeIdentity !== null &&
      this.queue.length >= config.security.ingestQueueSize
    ) {
      throw new ApiError(429, "BUSY", "The ingest queue is full", 30);
    }
    if (signal.aborted) {
      throw new ApiError(400, "REQUEST_CANCELLED", "Request cancelled");
    }

    this.globalJobs++;
    this.userJobs.set(identity, (this.userJobs.get(identity) ?? 0) + 1);
    if (this.activeIdentity === null) {
      this.activeIdentity = identity;
      return Promise.resolve(this.releaseFor(identity));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        identity,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new ApiError(400, "REQUEST_CANCELLED", "Request cancelled"));
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private releaseFor(identity: string): () => void {
    let released = false;
    return () => {
      if (released || this.activeIdentity !== identity) return;
      released = true;
      this.activeIdentity = null;
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.signal.removeEventListener("abort", next.onAbort);
        if (next.signal.aborted) continue;
        this.activeIdentity = next.identity;
        next.resolve(this.releaseFor(next.identity));
        break;
      }
    };
  }

  private resetDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.day) return;
    this.day = today;
    this.globalJobs = 0;
    this.userJobs.clear();
  }
}

const ingestGate = new IngestGate();

class SemanticSearchGate {
  private windows = new Map<string, { startedAt: number; count: number }>();

  check(identity: string): void {
    const now = Date.now();
    const current = this.windows.get(identity);
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(identity, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= config.security.semanticSearchesPerMinute) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Semantic search rate limit reached",
        Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1000)),
      );
    }
    current.count++;
  }
}

const semanticSearchGate = new SemanticSearchGate();

function asSseData(data: unknown): SseData {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as SseData
    : {};
}

export function createHandler(db: DB): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path.startsWith("/api/")) {
        const identity = authenticate(req);
        if (method !== "GET" && method !== "HEAD") validateMutation(req, url);

        if (path === "/api/config" && method === "GET") {
          return json({
            labelZoomThreshold: config.ui.labelZoomThreshold,
            sliderMin: config.ui.sliderMin,
            sliderMax: config.ui.sliderMax,
            sliderStep: config.ui.sliderStep,
            defaultSimilarity: config.link.similarityThreshold,
          });
        }
        if (path === "/api/status" && method === "GET") {
          return json({ status: "ok" });
        }
        if (path === "/api/notes" && method === "GET") {
          return json({
            notes: db.getAllNotes().map(({ id, title, source_url }) => ({
              id,
              title,
              source_url,
            })),
          });
        }
        if (path.startsWith("/api/notes/") && method === "GET") {
          const id = Number(path.split("/")[3]);
          if (!Number.isSafeInteger(id) || id < 1) {
            throw new ApiError(400, "INVALID_INPUT", "Invalid note ID");
          }
          const note = db.getNote(id);
          if (!note) throw new ApiError(404, "NOT_FOUND", "Not found");
          const content = await Deno.readTextFile(note.file_path);
          return json({
            id: note.id,
            title: note.title,
            source_url: note.source_url,
            source_type: note.source_type,
            content,
            related: db.getRelatedNotes(id),
          });
        }

        if (path === "/api/ingest" && method === "POST") {
          requireIngester(identity);
          const body = await readJson(req);
          const source = readSource(body);
          const textInput = !isUrl(source);
          if (!textInput) validateYouTubeUrl(source);
          else if (source.length > config.security.maxPastedTextChars) {
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
          return ingestStream(requestId, release, async (send) => {
            const ingested = textInput
              ? ingestText(title, source)
              : await ingestYouTube(source);
            send("ingested", { title: ingested.title });
            return await processAndLink(db, ingested, textInput, send);
          });
        }

        if (path === "/api/ingest/playlist" && method === "POST") {
          requireIngester(identity);
          if (!config.ingest.playlistEnabled) {
            throw new ApiError(404, "NOT_FOUND", "Not found");
          }
          const body = await readJson(req);
          const playlistUrl = requiredString(body.url, "url", 2048);
          validateYouTubeUrl(playlistUrl);
          const release = await ingestGate.acquire(identity, req.signal);
          return playlistStream(db, requestId, release, playlistUrl);
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
          const mode = url.searchParams.get("mode") ?? "semantic";
          if (mode !== "keyword" && mode !== "semantic") {
            throw new ApiError(400, "INVALID_INPUT", "Invalid search mode");
          }
          try {
            if (mode === "semantic") semanticSearchGate.check(identity);
            const results = mode === "keyword"
              ? db.searchKeyword(q).map((r) => ({
                id: r.id,
                title: r.title,
                score: 1 / (1 + Math.abs(r.rank)),
                matchType: "keyword",
              }))
              : db.searchSemantic(
                await DB.embedText(
                  q,
                  config.embed.apiBase,
                  config.embed.apiKey,
                  config.embed.model,
                ),
              ).map((r) => ({
                id: r.note_id,
                title: r.title,
                score: r.similarity,
                matchType: "semantic",
              }));
            return json({ results, query: q });
          } catch (err) {
            logFailure(requestId, "Search", err);
            return errorResponse(
              500,
              "SEARCH_FAILED",
              "Search failed",
              requestId,
            );
          }
        }

        if (path === "/api/graph" && method === "GET") {
          return json({
            nodes: db.getAllNotes().map((n) => ({ id: n.id, title: n.title })),
            links: db.getLinks().map((l) => ({
              source: l.source,
              target: l.target,
              similarity: l.similarity,
            })),
          });
        }
        throw new ApiError(404, "NOT_FOUND", "Not found");
      }

      return await serveStatic(path);
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(
          err.status,
          err.code,
          err.message,
          requestId,
          err.retryAfter,
        );
      }
      logFailure(requestId, "Request", err);
      return errorResponse(500, "INTERNAL_ERROR", "Request failed", requestId);
    }
  };
}

function authenticate(req: Request): string {
  if (!config.security.trustProxyAuth) return "local";
  if (
    !config.security.publicOrigin || config.security.allowedEmails.length === 0
  ) {
    throw new ApiError(
      503,
      "AUTH_MISCONFIGURED",
      "Authentication is unavailable",
    );
  }
  const identity = req.headers.get("Cf-Access-Authenticated-User-Email")?.trim()
    .toLowerCase();
  if (!identity) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  if (!config.security.allowedEmails.includes(identity)) {
    throw new ApiError(403, "FORBIDDEN", "Access denied");
  }
  return identity;
}

function requireIngester(identity: string): void {
  if (
    identity !== "local" && !config.security.ingesterEmails.includes(identity)
  ) {
    throw new ApiError(403, "FORBIDDEN", "Ingest permission required");
  }
}

function validateMutation(req: Request, requestUrl: URL): void {
  const expected = config.security.publicOrigin ?? requestUrl.origin;
  if (
    req.headers.get("Origin") !== expected ||
    req.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request origin rejected");
  }
  if (
    req.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) {
    throw new ApiError(
      415,
      "INVALID_CONTENT_TYPE",
      "Content-Type must be application/json",
    );
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (declared > config.security.maxBodyBytes) {
    throw new ApiError(413, "INPUT_TOO_LARGE", "Request body is too large");
  }
  if (!req.body) throw new ApiError(400, "INVALID_JSON", "JSON body required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.security.maxBodyBytes) {
        await reader.cancel();
        throw new ApiError(413, "INPUT_TOO_LARGE", "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Invalid JSON body");
  }
}

function readSource(body: Record<string, unknown>): string {
  const hasUrl = body.url !== undefined;
  const hasText = body.text !== undefined;
  if (hasUrl === hasText) {
    throw new ApiError(400, "INVALID_INPUT", "Provide either 'url' or 'text'");
  }
  return requiredString(
    hasUrl ? body.url : body.text,
    hasUrl ? "url" : "text",
    config.security.maxPastedTextChars,
  );
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      `'${name}' must be a non-empty string`,
    );
  }
  const result = value.trim();
  if (result.length > max) {
    throw new ApiError(413, "INPUT_TOO_LARGE", `'${name}' is too long`);
  }
  return result;
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, max);
}

async function processAndLink(
  db: DB,
  ingested: { transcript: string; sourceUrl: string; title: string },
  textInput: boolean,
  send: (stage: string, data?: unknown) => void,
) {
  send("extracting");
  const result = await processSingleSource(db, ingested, textInput, send);
  send("integrated", {
    new: result.newCount,
    merge: result.mergeCount,
    contradict: result.contradictCount,
  });
  send("linking");
  db.computeLinksFor(result.touchedIds, config.link.similarityThreshold);
  return result.notes;
}

function ingestStream(
  requestId: string,
  release: () => void,
  run: (
    send: (stage: string, data?: unknown) => void,
  ) => Promise<Array<{ id: number; title: string }>>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (stage: string, data?: unknown) =>
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ stage, ...asSseData(data) })}\n\n`,
          ),
        );
      try {
        send("ingesting", { title: "Processing source..." });
        send("done", { notes: await run(send) });
      } catch (err) {
        logFailure(requestId, "Ingest", err);
        try {
          send("error", {
            error: "Ingest failed",
            code: "INGEST_FAILED",
            requestId,
          });
        } catch { /* disconnected */ }
      } finally {
        release();
        try {
          controller.close();
        } catch { /* disconnected */ }
      }
    },
  });
  return new Response(stream, {
    headers: responseHeaders("text/event-stream"),
  });
}

function playlistStream(
  db: DB,
  requestId: string,
  release: () => void,
  playlistUrl: string,
): Response {
  return ingestStream(requestId, release, async (send) => {
    const videoUrls = await getPlaylistVideos(playlistUrl);
    send("ingested", { title: `${videoUrls.length} videos found` });
    const notes: Array<{ id: number; title: string }> = [];
    let failures = 0;
    for (let i = 0; i < videoUrls.length; i++) {
      try {
        send("distilling", { title: `Video ${i + 1}/${videoUrls.length}` });
        notes.push(
          ...await processAndLink(
            db,
            await ingestYouTube(videoUrls[i]),
            false,
            send,
          ),
        );
      } catch (err) {
        failures++;
        logFailure(requestId, `Playlist video ${i + 1}`, err);
      }
    }
    if (failures) {
      send("warning", {
        error: `${failures} playlist item(s) failed`,
        requestId,
      });
    }
    return notes;
  });
}

function logFailure(requestId: string, operation: string, err: unknown): void {
  console.error(`[${requestId}] ${operation} failed: ${errMsg(err)}`);
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryAfter?: number,
): Response {
  const headers = responseHeaders("application/json");
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
  return new Response(JSON.stringify({ error: message, code, requestId }), {
    status,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders("application/json"),
  });
}

function responseHeaders(contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
}

async function serveStatic(path: string): Promise<Response> {
  if (path === "/") path = "/index.html";
  const webRoot = await Deno.realPath("web");
  const candidate = await Deno.realPath(`web${path}`).catch(() => null);
  if (!candidate || !candidate.startsWith(`${webRoot}/`)) {
    return new Response("Not found", {
      status: 404,
      headers: responseHeaders("text/plain"),
    });
  }
  try {
    return new Response(await Deno.readFile(candidate), {
      headers: responseHeaders(getContentType(path)),
    });
  } catch {
    return new Response("Not found", {
      status: 404,
      headers: responseHeaders("text/plain"),
    });
  }
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
