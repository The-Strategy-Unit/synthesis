// HTTP routing: the entire `/api/*` table plus static file serving.

import { render as renderMarkdown } from "gfm";

import { config } from "./config.ts";
import { errMsg } from "./utils.ts";
import { DB, type DiscoveryStatus } from "./db.ts";
import { resolveWebAsset } from "./static_files.ts";
import {
  confirmDiscovery,
  DiscoveryBatchInputError,
  DiscoveryNotFoundError,
  DiscoveryStateError,
  generateDiscoveries,
  getDiscoveryView,
  listDiscoveryViews,
  reviewDiscovery,
  reviewDiscoveryBatch,
  validateDiscoveryBatchRequest,
} from "./discovery.ts";
import { LlmServiceError } from "./llm.ts";
import {
  getPlaylistVideos,
  type IngestResult,
  ingestText,
  ingestYouTube,
  normalizeYouTubePlaylistInput,
  normalizeYouTubeVideoInput,
} from "./ingest.ts";
import { ingestLocalFile, LocalFileError } from "./local_file.ts";
import {
  type IngestProposalApproval,
  validateIngestProposalApproval,
} from "./ingest_proposal.ts";
import type { IngestReviewAudit } from "./ingest_history.ts";
import {
  IngestUndoConflictError,
  IngestUndoNotAvailableError,
  undoLastIngest,
} from "./ingest_undo.ts";
import { exportVault } from "./vault_export.ts";
import { rebuildVaultCatalog, VaultRebuildError } from "./vault_rebuild.ts";
import {
  type AppliedIngestResult,
  approveIngestProposal,
  getIngestProposalReview,
  IngestProposalApprovalError,
  IngestProposalNotFoundError,
  IngestProposalStateError,
  InvalidWikiLinkError,
  listIngestProposalReviews,
  rejectIngestProposal,
  stageSingleSource,
  StaleIngestProposalError,
} from "./orchestrate.ts";
import { answerWiki, validateWikiAnswer, type WikiQueryPage } from "./query.ts";
import {
  type ActiveProviders,
  checkProviderReadiness,
  diagnoseProviders,
  embeddingIdentity,
  environmentProviders,
  providerMode,
  ProviderRuntimeError,
} from "./provider_runtime.ts";
import {
  rebuildSemanticIndex,
  validateSemanticRebuildLimit,
} from "./semantic_index.ts";
import type { ProviderProfileStore } from "./provider_profile_store.ts";
import { ProviderProfileError } from "./provider_profile.ts";
import {
  configureProviders,
  ProviderSettingsInputError,
  providerSettingsStatus,
} from "./provider_settings.ts";
import type { SecretStore } from "./secret_store.ts";
import { saveWikiSynthesis, WikiPageExistsError } from "./wiki_store.ts";
import { analyzeWikiHealth, lintWiki } from "./wiki_lint.ts";
import { ensureWikiSchema, saveWikiSchema } from "./wiki_schema.ts";
import { buildWikiGraph, getRelatedWikiPages } from "./wiki_graph.ts";
import {
  TrustedBatchInputError,
  validateTrustedBatchRequest,
} from "./trusted_batch.ts";
import {
  findClaimCitations,
  findSourceReferencePages,
  parseWikiPage,
} from "./wiki.ts";

type ProviderResolver = () => Promise<ActiveProviders>;
type ProviderSettingsDependencies = {
  profiles: Pick<ProviderProfileStore, "load" | "save">;
  secrets: SecretStore | (() => Promise<SecretStore>);
};
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
      `${error.message}. Reject it and ingest the source again.`,
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

function asSseData(data: unknown): SseData {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as SseData
    : {};
}

function semanticIndexView(
  status: ReturnType<DB["semanticIndexStatus"]> & {
    processed?: number;
    links?: number;
  },
) {
  return {
    compatible: status.compatible,
    embedded: status.embedded,
    total: status.total,
    remaining: status.remaining,
    complete: status.complete,
    ...(status.processed === undefined ? {} : { processed: status.processed }),
    ...(status.links === undefined ? {} : { links: status.links }),
  };
}

export function createHandler(
  db: DB,
  resolveProviders: ProviderResolver = () =>
    Promise.resolve(environmentProviders()),
  providerSettings?: ProviderSettingsDependencies,
  ingestDependencies: IngestDependencies = { ingestYouTube },
): (req: Request) => Promise<Response> {
  const ingestGate = new IngestGate();
  const semanticSearchGate = new SemanticSearchGate();
  return async function handle(req: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path.startsWith("/api/")) {
        const identity = authenticate(req);
        if (method !== "GET" && method !== "HEAD") {
          validateMutation(req, url, path);
        }

        if (path === "/api/config" && method === "GET") {
          return json({
            labelZoomThreshold: config.ui.labelZoomThreshold,
            semanticNeighbors: Math.min(
              config.link.visibleNeighbors,
              config.link.k,
            ),
            maxSemanticNeighbors: config.link.k,
          });
        }
        if (path === "/api/status" && method === "GET") {
          return json({ status: "ok" });
        }
        if (path === "/api/schema" && method === "GET") {
          return json({ schema: await ensureWikiSchema() });
        }
        if (path === "/api/export" && method === "GET") {
          const exported = await exportVault();
          const headers = responseHeaders("application/x-tar");
          const date = new Date().toISOString().slice(0, 10);
          headers.set(
            "Content-Disposition",
            `attachment; filename="synthesis-vault-${date}.tar"`,
          );
          headers.set("X-Synthesis-File-Count", String(exported.fileCount));
          return new Response(exported.stream, { headers });
        }
        if (path === "/api/rebuild" && method === "POST") {
          requireIngester(identity);
          const body = await readJson(req);
          if (body.confirm !== "REBUILD") {
            throw new ApiError(
              400,
              "CONFIRMATION_REQUIRED",
              "Set 'confirm' to 'REBUILD' to rebuild the local catalog",
            );
          }
          const release = await ingestGate.acquire(identity, req.signal, {
            countTowardsQuota: false,
          });
          try {
            return json({ rebuild: await rebuildVaultCatalog(db) });
          } catch (error) {
            if (error instanceof VaultRebuildError) {
              throw new ApiError(
                422,
                "VAULT_PREFLIGHT_FAILED",
                error.message,
              );
            }
            throw error;
          } finally {
            release();
          }
        }
        if (path === "/api/semantic-index" && method === "GET") {
          return json({
            semanticIndex: semanticIndexView(db.semanticIndexStatus()),
          });
        }
        if (path === "/api/semantic-index/rebuild" && method === "POST") {
          requireIngester(identity);
          const body = await readJson(req);
          if (body.confirm !== "REBUILD SEMANTIC INDEX") {
            throw new ApiError(
              400,
              "CONFIRMATION_REQUIRED",
              "Set 'confirm' to 'REBUILD SEMANTIC INDEX' to rebuild semantic search and suggestions",
            );
          }
          let limit: number;
          try {
            limit = validateSemanticRebuildLimit(body.limit);
          } catch (error) {
            throw new ApiError(400, "INVALID_INPUT", errMsg(error));
          }
          semanticSearchGate.check(identity);
          const release = await ingestGate.acquire(identity, req.signal, {
            countTowardsQuota: false,
          });
          try {
            return json({
              semanticIndex: semanticIndexView(
                await rebuildSemanticIndex(
                  db,
                  await resolveProviders(),
                  limit,
                ),
              ),
            });
          } finally {
            release();
          }
        }
        if (path === "/api/schema" && method === "PUT") {
          requireIngester(identity);
          const body = await readJson(req);
          try {
            return json({ schema: await saveWikiSchema(body.schema) });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("Wiki schema")
            ) {
              throw new ApiError(
                400,
                "INVALID_SCHEMA",
                "Wiki schema is invalid",
              );
            }
            throw error;
          }
        }
        if (path === "/api/proposals" && method === "GET") {
          const status = url.searchParams.get("status") ?? "pending";
          if (!["pending", "approved", "rejected", "all"].includes(status)) {
            throw new ApiError(
              400,
              "INVALID_INPUT",
              "Invalid proposal status",
            );
          }
          return json({
            proposals: listIngestProposalReviews(
              db,
              status === "all"
                ? undefined
                : status as "pending" | "approved" | "rejected",
            ),
          });
        }
        const proposalMatch = path.match(
          /^\/api\/proposals\/(\d+)(?:\/(approve|reject))?$/,
        );
        if (proposalMatch) {
          const proposalId = Number(proposalMatch[1]);
          const action = proposalMatch[2];
          if (!Number.isSafeInteger(proposalId) || proposalId < 1) {
            throw new ApiError(400, "INVALID_INPUT", "Invalid proposal ID");
          }
          if (!action && method === "GET") {
            return json({ proposal: getIngestProposalReview(db, proposalId) });
          }
          if (action === "reject" && method === "POST") {
            requireIngester(identity);
            return json({ proposal: rejectIngestProposal(db, proposalId) });
          }
          if (action === "approve" && method === "POST") {
            requireIngester(identity);
            let approval;
            try {
              approval = validateIngestProposalApproval(
                req.body ? await readJson(req) : {},
                { requireChanges: true },
              );
            } catch (error) {
              throw new ApiError(
                400,
                "INVALID_PROPOSAL_APPROVAL",
                errMsg(error),
              );
            }
            if (approval.changes) {
              const proposal = getIngestProposalReview(db, proposalId);
              const invalid = approval.changes.find((change) =>
                change.index >= proposal.changes.length
              );
              if (invalid) {
                throw new ApiError(
                  400,
                  "INVALID_PROPOSAL_APPROVAL",
                  `Ingest proposal approval index ${invalid.index} is out of range`,
                );
              }
            }
            const release = await ingestGate.acquire(identity, req.signal);
            return ingestStream(
              requestId,
              release,
              req.signal,
              async (send, signal) => {
                const providers = await resolveProviders();
                const result = await approveProposalAndRefresh(
                  db,
                  requestId,
                  proposalId,
                  send,
                  providers,
                  { approval, signal },
                );
                return result.notes;
              },
            );
          }
        }
        if (path === "/api/discoveries" && method === "GET") {
          const status = url.searchParams.get("status") ?? "open";
          const allowed = [
            "open",
            "pending",
            "investigating",
            "confirmed",
            "rejected",
            "all",
          ];
          if (!allowed.includes(status)) {
            throw new ApiError(
              400,
              "INVALID_INPUT",
              "Invalid discovery status",
            );
          }
          const discoveries = listDiscoveryViews(
            db,
            ["all", "open"].includes(status)
              ? undefined
              : status as DiscoveryStatus,
          ).filter((discovery) =>
            status !== "open" ||
            ["pending", "investigating"].includes(discovery.status)
          );
          return json({ discoveries });
        }
        if (path === "/api/discoveries/generate" && method === "POST") {
          requireIngester(identity);
          const body = await readJson(req);
          const generation = optionalString(
            body.generation,
            "generation",
            100,
          );
          if (
            generation !== undefined &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              .test(generation)
          ) {
            throw new ApiError(
              400,
              "INVALID_INPUT",
              "Invalid synthesis generation",
            );
          }
          const pageIds = body.pageIds === undefined
            ? db.getAllNotes().map((note) => note.id)
            : positiveIdArray(body.pageIds, "pageIds", 12);
          semanticSearchGate.check(identity);
          const release = await ingestGate.acquire(identity, req.signal, {
            countTowardsQuota: false,
          });
          try {
            const providers = await resolveProviders();
            return json(
              await generateDiscoveries(
                db,
                pageIds,
                providers.llm.apiBase,
                providers.llm.apiKey,
                providers.llm.consolidateModel,
                await ensureWikiSchema(),
                {
                  scope: body.pageIds === undefined ? "vault" : "seeded",
                  generation,
                },
              ),
            );
          } finally {
            release();
          }
        }
        if (path === "/api/discoveries/batch" && method === "POST") {
          requireIngester(identity);
          const batch = validateDiscoveryBatchRequest(await readJson(req));
          const release = await ingestGate.acquire(identity, req.signal, {
            countTowardsQuota: false,
          });
          try {
            return json(await reviewDiscoveryBatch(db, batch));
          } finally {
            release();
          }
        }
        const discoveryMatch = path.match(
          /^\/api\/discoveries\/(\d+)(?:\/(investigate|confirm|reject))?$/,
        );
        if (discoveryMatch) {
          const discoveryId = Number(discoveryMatch[1]);
          const action = discoveryMatch[2];
          if (!Number.isSafeInteger(discoveryId) || discoveryId < 1) {
            throw new ApiError(400, "INVALID_INPUT", "Invalid discovery ID");
          }
          if (!action && method === "GET") {
            return json({ discovery: getDiscoveryView(db, discoveryId) });
          }
          if (action && method === "POST") {
            requireIngester(identity);
            const release = await ingestGate.acquire(identity, req.signal, {
              countTowardsQuota: false,
            });
            try {
              const discovery = action === "confirm"
                ? await confirmDiscovery(db, discoveryId)
                : await reviewDiscovery(
                  db,
                  discoveryId,
                  action === "investigate" ? "investigating" : "rejected",
                );
              return json({ discovery });
            } finally {
              release();
            }
          }
        }
        if (path === "/api/provider" && method === "GET") {
          if (!providerSettings) {
            const providers = environmentProviders();
            return json({
              configured: true,
              source: "environment",
              mode: providerMode(providers),
              profile: null,
              llmKeyStored: true,
              embeddingKeyStored: true,
              embeddingDimensions: config.embed.dimensions,
            });
          }
          const status = await providerSettingsStatus(
            providerSettings.profiles,
            providerSettings.secrets,
          );
          const usesEnvironment = status.profile === null;
          const activeProvider = status.profile ?? environmentProviders();
          return json({
            ...status,
            configured: usesEnvironment || status.configured,
            source: usesEnvironment ? "environment" : "profile",
            mode: providerMode(activeProvider),
            embeddingDimensions: config.embed.dimensions,
          });
        }
        if (path === "/api/provider/readiness" && method === "GET") {
          let providers: ActiveProviders | undefined;
          try {
            providers = await resolveProviders();
            return json({
              readiness: await checkProviderReadiness(providers),
              semanticIndex: semanticIndexView(db.semanticIndexStatus(
                embeddingIdentity(providers.embedding),
              )),
            });
          } catch {
            const mode = providers
              ? providerMode(providers)
              : providerMode(environmentProviders());
            return errorResponse(
              503,
              "PROVIDER_UNAVAILABLE",
              mode === "local"
                ? "Local AI is unavailable. Existing wiki knowledge and keyword search remain available."
                : "Remote AI is unavailable. Existing wiki knowledge and keyword search remain available.",
              requestId,
            );
          }
        }
        if (path === "/api/provider/diagnose" && method === "POST") {
          requireIngester(identity);
          let providers: ActiveProviders | undefined;
          try {
            providers = await resolveProviders();
            return json({ diagnostics: await diagnoseProviders(providers) });
          } catch (error) {
            logFailure(requestId, "Provider diagnostics", error);
            const mode = providers
              ? providerMode(providers)
              : providerMode(environmentProviders());
            throw new ApiError(
              502,
              "PROVIDER_UNAVAILABLE",
              mode === "local"
                ? "Local provider unavailable. Start Ollama, then run the suggested ollama pull commands."
                : "Remote provider unavailable. Check its endpoint, credentials, and model access.",
            );
          }
        }
        if (path === "/api/provider" && method === "POST") {
          requireIngester(identity);
          if (!providerSettings) {
            throw new ApiError(
              501,
              "NOT_IMPLEMENTED",
              "Provider settings are unavailable",
            );
          }
          const body = await readJson(req);
          try {
            const status = await configureProviders(
              providerSettings.profiles,
              providerSettings.secrets,
              {
                profile: body.profile,
                llmApiKey: body.llmApiKey,
                embeddingApiKey: body.embeddingApiKey,
              },
            );
            if (!status.profile) {
              throw new ProviderRuntimeError(
                "Saved provider profile is unavailable",
              );
            }
            const semanticIndex = semanticIndexView(db.activateSemanticIndex(
              embeddingIdentity({
                apiBase: status.profile.embedding.apiBase,
                model: status.profile.embedding.model,
              }),
            ));
            return json({
              ...status,
              source: "profile",
              semanticIndex,
            });
          } catch (error) {
            if (
              error instanceof ProviderProfileError ||
              error instanceof ProviderSettingsInputError
            ) {
              throw new ApiError(
                400,
                "INVALID_INPUT",
                "Provider settings are invalid",
              );
            }
            if (error instanceof ProviderRuntimeError) {
              logFailure(requestId, "Provider configuration", error);
              throw new ApiError(
                502,
                "PROVIDER_CONFIGURATION_FAILED",
                error.message,
              );
            }
            logFailure(requestId, "Provider configuration", error);
            return errorResponse(
              502,
              "PROVIDER_CONFIGURATION_FAILED",
              "Provider configuration failed",
              requestId,
            );
          }
        }
        if (path === "/api/lint" && method === "GET") {
          return json(await lintWiki(db));
        }
        if (path === "/api/lint/analyze" && method === "POST") {
          try {
            semanticSearchGate.check(identity);
            const report = await lintWiki(db);
            const context = await wikiLintContext(
              db,
              report.issues.map((issue) => issue.pageId),
            );
            if (context.length === 0) {
              throw new ApiError(
                422,
                "NO_WIKI_CONTEXT",
                "No readable wiki pages were found",
              );
            }
            const providers = await resolveProviders();
            const schema = await ensureWikiSchema();
            return json(
              await analyzeWikiHealth(
                report,
                context,
                providers.llm.apiBase,
                providers.llm.apiKey,
                providers.llm.consolidateModel,
                schema,
              ),
            );
          } catch (error) {
            if (
              error instanceof ApiError || error instanceof LlmServiceError
            ) {
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
            notes: db.getAllNotes().map(({ id, title, source_url }) => ({
              id,
              title,
              source_url,
            })),
          });
        }
        if (path === "/api/sources" && method === "GET") {
          return json({
            sources: db.getAllSources().map((source) => ({
              id: source.id,
              title: source.title,
              sourceUrl: source.source_url,
              sourceType: source.source_type,
              summary: source.summary,
              createdAt: source.created_at,
              pageCount: db.getNotesForSource(source.id).length,
            })),
          });
        }
        if (path.startsWith("/api/sources/") && method === "GET") {
          const id = Number(path.split("/")[3]);
          if (!Number.isSafeInteger(id) || id < 1) {
            throw new ApiError(400, "INVALID_INPUT", "Invalid source ID");
          }
          const source = db.getSource(id);
          if (!source) throw new ApiError(404, "NOT_FOUND", "Not found");
          return json({
            id: source.id,
            title: source.title,
            sourceUrl: source.source_url,
            sourceType: source.source_type,
            summary: source.summary,
            createdAt: source.created_at,
            pages: await Promise.all(
              db.getNotesForSource(id).map(async (note) => {
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
          const note = db.getNote(id);
          if (!note) throw new ApiError(404, "NOT_FOUND", "Not found");
          const content = await Deno.readTextFile(note.file_path);
          const page = parseWikiPage(content);
          const provenance = db.getSourceProvenanceForNote(id);
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
                `Wiki claim ${index + 1} has uncataloged source provenance`,
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
          const playlistUrl = normalizePlaylistInput(
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
            const context = await retrieveWikiContext(db, question, providers);
            if (context.length === 0) {
              throw new ApiError(
                422,
                "NO_WIKI_CONTEXT",
                "No relevant wiki pages were found",
              );
            }
            const result = await answerWiki(
              question,
              context,
              providers.llm.apiBase,
              providers.llm.apiKey,
              providers.llm.consolidateModel,
              await ensureWikiSchema(),
            );
            const titles = new Map(
              context.map((page) => [page.id, page.title]),
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
            if (
              error instanceof ApiError || error instanceof LlmServiceError
            ) {
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
          const context = await loadWikiPages(db, citationIds);
          let result;
          try {
            result = validateWikiAnswer({
              answer: body.answer,
              citations: citationIds,
              suggested_page: body.suggestedPage,
            }, context);
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
          } catch (err) {
            if (err instanceof ApiError) throw err;
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
          return json(await buildWikiGraph(db));
        }
        throw new ApiError(404, "NOT_FOUND", "Not found");
      }

      return await serveStatic(path);
    } catch (err) {
      const discoveryError = asDiscoveryApiError(err);
      if (discoveryError) {
        return errorResponse(
          discoveryError.status,
          discoveryError.code,
          discoveryError.message,
          requestId,
        );
      }
      const proposalError = asProposalApiError(err);
      if (proposalError) {
        return errorResponse(
          proposalError.status,
          proposalError.code,
          proposalError.message,
          requestId,
        );
      }
      if (err instanceof ApiError) {
        return errorResponse(
          err.status,
          err.code,
          err.message,
          requestId,
          err.retryAfter,
        );
      }
      if (err instanceof LlmServiceError) {
        logFailure(requestId, "LLM request", err);
        return errorResponse(
          502,
          "LLM_SERVICE_ERROR",
          err.message,
          requestId,
        );
      }
      logFailure(requestId, "Request", err);
      return errorResponse(500, "INTERNAL_ERROR", "Request failed", requestId);
    }
  };
}

async function loadWikiPages(
  db: DB,
  noteIds: number[],
): Promise<WikiQueryPage[]> {
  const pages: WikiQueryPage[] = [];
  for (const id of [...new Set(noteIds)]) {
    const note = db.getNote(id);
    if (!note) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        `Cited wiki page ${id} not found`,
      );
    }
    pages.push({
      id: note.id,
      title: note.title,
      content: (await Deno.readTextFile(note.file_path)).slice(0, 12_000),
    });
  }
  return pages;
}

async function retrieveWikiContext(
  db: DB,
  question: string,
  providers: ActiveProviders,
): Promise<WikiQueryPage[]> {
  const keywordIds = db.findIntegrationCandidates(question, 6).map((page) =>
    page.id
  );
  let semanticIds: number[] = [];
  try {
    requireSemanticIndex(db, providers);
    const embedding = await DB.embedText(
      question,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
    );
    semanticIds = db.searchSemantic(embedding, 8).map((result) =>
      result.note_id
    );
  } catch {
    // Keyword and explicit-link retrieval remain available without embeddings.
  }

  const seedIds = [...new Set([...keywordIds, ...semanticIds])].slice(0, 8);
  if (seedIds.length === 0) return [];
  const graph = await buildWikiGraph(db);
  const explicitNeighbors = new Map<number, number[]>();
  for (const link of graph.links) {
    if (link.kind !== "explicit") continue;
    explicitNeighbors.set(link.source, [
      ...(explicitNeighbors.get(link.source) ?? []),
      link.target,
    ]);
    explicitNeighbors.set(link.target, [
      ...(explicitNeighbors.get(link.target) ?? []),
      link.source,
    ]);
  }
  const expandedIds = seedIds.flatMap((id) => explicitNeighbors.get(id) ?? []);
  return await loadWikiPages(
    db,
    [...new Set([...seedIds, ...expandedIds])].slice(0, 12),
  );
}

function requireSemanticIndex(
  db: DB,
  providers: ActiveProviders,
): void {
  const status = db.semanticIndexStatus(
    embeddingIdentity(providers.embedding),
  );
  if (!status.complete) {
    throw new ApiError(
      409,
      "SEMANTIC_INDEX_INCOMPLETE",
      `Semantic index is incomplete (${status.embedded}/${status.total} pages). Rebuild or resume it, or use keyword search.`,
    );
  }
}

async function wikiLintContext(
  db: DB,
  priorityIds: number[],
): Promise<WikiQueryPage[]> {
  const orderedIds = [
    ...new Set([
      ...priorityIds,
      ...db.getAllNotes().map((note) => note.id),
    ]),
  ].slice(0, 12);
  const pages: WikiQueryPage[] = [];
  for (const id of orderedIds) {
    const note = db.getNote(id);
    if (!note) continue;
    try {
      pages.push({
        id: note.id,
        title: note.title,
        content: (await Deno.readTextFile(note.file_path)).slice(0, 12_000),
      });
    } catch {
      // The deterministic report already records unreadable registered pages.
    }
  }
  return pages;
}

async function semanticSearch(
  db: DB,
  query: string,
  identity: string,
  resolveProviders: ProviderResolver,
  gate: SemanticSearchGate,
) {
  gate.check(identity);
  const provider = await resolveProviders();
  requireSemanticIndex(db, provider);
  return db.searchSemantic(
    await DB.embedText(
      query,
      provider.embedding.apiBase,
      provider.embedding.apiKey,
      provider.embedding.model,
    ),
  ).map((r) => ({
    id: r.note_id,
    title: r.title,
    score: r.similarity,
    matchType: "semantic",
  }));
}

function keywordSearch(db: DB, query: string) {
  return db.searchKeyword(query).map((result) => ({
    id: result.id,
    title: result.title,
    // SQLite FTS ranks better matches with smaller values. Negating the rank
    // gives every search mode the same public ordering rule: higher is better.
    score: -result.rank,
    matchType: "keyword",
  }));
}

async function hybridSearch(
  db: DB,
  query: string,
  identity: string,
  resolveProviders: ProviderResolver,
  gate: SemanticSearchGate,
) {
  try {
    const provider = await resolveProviders();
    requireSemanticIndex(db, provider);
    gate.check(identity);
    return await db.search(
      query,
      provider.embedding.apiBase,
      provider.embedding.apiKey,
      provider.embedding.model,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "RATE_LIMITED") {
      throw error;
    }
    return keywordSearch(db, query);
  }
}

function orderSearchResults<
  T extends { title: string; score: number },
>(results: T[]): T[] {
  return [...results].sort((left, right) =>
    right.score - left.score ||
    left.title.localeCompare(right.title, "en-US")
  );
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
    return { kind: "youtube", value: normalizeYouTubeVideoInput(value) };
  } catch (error) {
    throw new ApiError(400, "INVALID_YOUTUBE_INPUT", errMsg(error));
  }
}

function normalizePlaylistInput(value: string): string {
  try {
    return normalizeYouTubePlaylistInput(value);
  } catch (error) {
    throw new ApiError(400, "INVALID_YOUTUBE_INPUT", errMsg(error));
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
    const semanticIndex = db.semanticIndexStatus();
    if (semanticIndex.complete) db.computeLinksFor(result.touchedIds);
    else {
      db.clearLinks();
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
      const semanticIndex = db.semanticIndexStatus();
      if (semanticIndex.complete) db.computeLinks(config.link.k);
      else db.clearLinks();
    }
    send("synthesizing", {
      batchId,
      scope: "vault",
      pageCount: db.getAllNotes().length,
    });
    try {
      let generation: string | undefined;
      while (true) {
        ensureIngestActive(signal);
        const synthesis = await generateDiscoveries(
          db,
          db.getAllNotes().map((note) => note.id),
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
