import type { DiscoveryStatus } from "../../catalogue/db.ts";
import {
  getIngestProposalReview,
  listIngestProposalReviews,
  rejectIngestProposal,
} from "../../ingest/orchestrate.ts";
import { validateIngestProposalApproval } from "../../ingest/ingest_proposal.ts";
import { errMsg } from "../../shared/utils.ts";
import {
  confirmDiscovery,
  generateDiscoveries,
  getDiscoveryView,
  listDiscoveryViews,
  reviewDiscovery,
  reviewDiscoveryBatch,
  validateDiscoveryBatchRequest,
} from "../../wiki/discovery.ts";
import { ensureWikiSchema } from "../../wiki/wiki_schema.ts";
import type { ApiRoute } from "../route_context.ts";
import {
  ApiError,
  approveProposalAndRefresh,
  ingestStream,
  json,
  optionalString,
  positiveIdArray,
  readJson,
  requireIngester,
} from "../support.ts";

export const handleReviewRoutes: ApiRoute = async (context) => {
  const {
    db,
    identity,
    ingestGate,
    method,
    path,
    req,
    requestId,
    resolveProviders,
    semanticSearchGate,
    url,
  } = context;

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
      ["all", "open"].includes(status) ? undefined : status as DiscoveryStatus,
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
      ? db.notes.getAllNotes().map((note) => note.id)
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
};
