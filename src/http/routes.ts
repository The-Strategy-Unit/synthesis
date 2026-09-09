// HTTP composition: authenticate once, then dispatch to capability routes.

import type { DB } from "../catalogue/db.ts";
import {
  emptyOutputTokenUsageSummary,
  type OutputTokenUsageReader,
} from "../provider/output_token_usage.ts";
import { environmentProviders } from "../provider/provider_runtime.ts";
import { handleIngestRoutes } from "./routes/ingest_routes.ts";
import { handleProviderRoutes } from "./routes/provider_routes.ts";
import { handleReviewRoutes } from "./routes/review_routes.ts";
import { handleSystemRoutes } from "./routes/system_routes.ts";
import { handleWikiRoutes } from "./routes/wiki_routes.ts";
import type { ApiRoute } from "./route_context.ts";
import {
  ApiError,
  authenticate,
  type IngestDependencies,
  IngestGate,
  type ProviderResolver,
  type ProviderSettingsDependencies,
  routeErrorResponse,
  serveStatic,
  validateMutation,
} from "./support.ts";
import { ingestYouTube } from "../ingest/ingest.ts";
import { deliveryFailureSignal } from "./request_completion.ts";

const API_ROUTES: readonly ApiRoute[] = [
  handleSystemRoutes,
  handleReviewRoutes,
  handleProviderRoutes,
  handleWikiRoutes,
  handleIngestRoutes,
];

const emptyProviderUsage: OutputTokenUsageReader = {
  summary: () => Promise.resolve(emptyOutputTokenUsageSummary()),
};

export function createHandler(
  db: DB,
  resolveProviders: ProviderResolver = () =>
    Promise.resolve(environmentProviders()),
  providerSettings?: ProviderSettingsDependencies,
  ingestDependencies: IngestDependencies = { ingestYouTube },
  providerUsage: OutputTokenUsageReader = emptyProviderUsage,
): (
  req: Request,
  info?: Pick<Deno.ServeHandlerInfo, "completed">,
) => Promise<Response> {
  const ingestGate = new IngestGate();

  return async function handle(
    req: Request,
    info?: Pick<Deno.ServeHandlerInfo, "completed">,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith("/api/")) return await serveStatic(path);

      const identity = authenticate(req);
      if (method !== "GET" && method !== "HEAD") {
        validateMutation(req, url, path);
      }
      const requestSignal = info
        ? deliveryFailureSignal(info.completed)
        : req.signal;

      const context = {
        db,
        identity,
        ingestDependencies,
        ingestGate,
        method,
        path,
        providerSettings,
        providerUsage,
        req,
        requestSignal,
        requestId,
        resolveProviders,
        url,
      };
      for (const route of API_ROUTES) {
        const response = await route(context);
        if (response) return response;
      }
      throw new ApiError(404, "NOT_FOUND", "Not found");
    } catch (error) {
      return routeErrorResponse(error, requestId);
    }
  };
}
