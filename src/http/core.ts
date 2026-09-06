import { config } from "../app/config.ts";
import {
  DiscoveryBatchInputError,
  DiscoveryNotFoundError,
  DiscoveryStateError,
} from "../wiki/discovery.ts";
import {
  IngestProposalApprovalError,
  IngestProposalNotFoundError,
  IngestProposalStateError,
  InvalidWikiLinkError,
  StaleIngestProposalError,
} from "../ingest/orchestrate.ts";
import { LlmServiceError } from "../provider/llm.ts";
import type { ActiveProviders } from "../provider/provider_runtime.ts";
import type { ProviderProfileStore } from "../provider/provider_profile_store.ts";
import type { SecretStore } from "../provider/secret_store.ts";
import { errMsg } from "../shared/utils.ts";
import { resolveWebAsset } from "./static_files.ts";

type ProviderResolver = () => Promise<ActiveProviders>;

type ProviderSettingsDependencies = {
  profiles: Pick<ProviderProfileStore, "load" | "save">;
  secrets: SecretStore | (() => Promise<SecretStore>);
};

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

function asProposalApiError(error: unknown): ApiError | undefined {
  if (error instanceof IngestProposalApprovalError) {
    return new ApiError(400, "INVALID_PROPOSAL_APPROVAL", error.message);
  }
  if (error instanceof InvalidWikiLinkError) {
    return new ApiError(422, "INVALID_WIKI_LINK", error.message);
  }
  if (error instanceof IngestProposalNotFoundError) {
    return new ApiError(404, "PROPOSAL_NOT_FOUND", error.message);
  }
  if (error instanceof IngestProposalStateError) {
    return new ApiError(409, "PROPOSAL_NOT_PENDING", error.message);
  }
  if (error instanceof StaleIngestProposalError) {
    return new ApiError(
      409,
      "PROPOSAL_STALE",
      `${error.message}. Reprocess it against the current wiki before reviewing it again.`,
    );
  }
  return undefined;
}

function asDiscoveryApiError(error: unknown): ApiError | undefined {
  if (error instanceof DiscoveryBatchInputError) {
    return new ApiError(400, error.code, error.message);
  }
  if (error instanceof DiscoveryNotFoundError) {
    return new ApiError(404, "DISCOVERY_NOT_FOUND", error.message);
  }
  if (error instanceof DiscoveryStateError) {
    return new ApiError(409, "DISCOVERY_NOT_REVIEWABLE", error.message);
  }
  return undefined;
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

  acquire(
    identity: string,
    signal: AbortSignal,
    options: { countTowardsQuota?: boolean } = {},
  ): Promise<() => void> {
    this.resetDay();
    const countTowardsQuota = options.countTowardsQuota !== false;
    if (
      this.activeIdentity === identity ||
      this.queue.some((entry) => entry.identity === identity)
    ) {
      throw new ApiError(429, "BUSY", "An ingest job is already pending", 30);
    }
    if (
      countTowardsQuota &&
      (this.userJobs.get(identity) ?? 0) >= config.security.perUserDailyJobs
    ) {
      throw new ApiError(
        429,
        "QUOTA_EXCEEDED",
        "Daily ingest quota reached",
        3600,
      );
    }
    if (
      countTowardsQuota && this.globalJobs >= config.security.globalDailyJobs
    ) {
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

    if (countTowardsQuota) {
      this.globalJobs++;
      this.userJobs.set(identity, (this.userJobs.get(identity) ?? 0) + 1);
    }
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

function validateMutation(
  req: Request,
  requestUrl: URL,
  path: string,
): void {
  const expected = config.security.publicOrigin ?? requestUrl.origin;
  if (
    req.headers.get("Origin") !== expected ||
    req.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request origin rejected");
  }
  const contentType = req.headers.get("Content-Type")?.split(";", 1)[0].trim()
    .toLowerCase();
  const expectedType = path === "/api/ingest/file"
    ? "multipart/form-data"
    : "application/json";
  if (contentType !== expectedType) {
    throw new ApiError(
      415,
      "INVALID_CONTENT_TYPE",
      `Content-Type must be ${expectedType}`,
    );
  }
}

function validateDeclaredSize(req: Request, maxBytes: number): void {
  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "INPUT_TOO_LARGE", "Request body is too large");
  }
}

async function readBodyBytes(
  req: Request,
  maxBytes: number,
  missingMessage: string,
): Promise<Uint8Array> {
  validateDeclaredSize(req, maxBytes);
  if (!req.body) throw new ApiError(400, "INVALID_INPUT", missingMessage);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
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
  return bytes;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) {
    throw new ApiError(400, "INVALID_JSON", "JSON body required");
  }
  const bytes = await readBodyBytes(
    req,
    config.security.maxBodyBytes,
    "JSON body required",
  );
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

function positiveIdArray(value: unknown, name: string, max: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      `'${name}' must contain 1-${max} page IDs`,
    );
  }
  const ids = value.map((id) => Number(id));
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  ) {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      `'${name}' must contain unique positive page IDs`,
    );
  }
  return ids;
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
  const candidate = await resolveWebAsset(path);
  if (!candidate) {
    return new Response("Not found", {
      status: 404,
      headers: responseHeaders("text/plain"),
    });
  }
  try {
    return new Response(await Deno.readFile(candidate), {
      headers: responseHeaders(
        getContentType(path === "/" ? "/index.html" : path),
      ),
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

function routeErrorResponse(error: unknown, requestId: string): Response {
  const discoveryError = asDiscoveryApiError(error);
  if (discoveryError) {
    return errorResponse(
      discoveryError.status,
      discoveryError.code,
      discoveryError.message,
      requestId,
    );
  }
  const proposalError = asProposalApiError(error);
  if (proposalError) {
    return errorResponse(
      proposalError.status,
      proposalError.code,
      proposalError.message,
      requestId,
    );
  }
  if (error instanceof ApiError) {
    return errorResponse(
      error.status,
      error.code,
      error.message,
      requestId,
      error.retryAfter,
    );
  }
  if (error instanceof LlmServiceError) {
    logFailure(requestId, "LLM request", error);
    return errorResponse(
      502,
      "LLM_SERVICE_ERROR",
      error.message,
      requestId,
    );
  }
  logFailure(requestId, "Request", error);
  return errorResponse(500, "INTERNAL_ERROR", "Request failed", requestId);
}

export {
  ApiError,
  asProposalApiError,
  authenticate,
  errorResponse,
  IngestGate,
  json,
  logFailure,
  optionalString,
  positiveIdArray,
  readBodyBytes,
  readJson,
  requiredString,
  requireIngester,
  responseHeaders,
  routeErrorResponse,
  SemanticSearchGate,
  serveStatic,
  validateDeclaredSize,
  validateMutation,
};
export type { ProviderResolver, ProviderSettingsDependencies };
