// HTTP composition: authenticate once, then dispatch to capability routes.

import type { DB } from "../catalogue/db.ts";
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
  SemanticSearchGate,
  serveStatic,
  validateMutation,
} from "./support.ts";
import { ingestYouTube } from "../ingest/ingest.ts";

const API_ROUTES: readonly ApiRoute[] = [
  handleSystemRoutes,
  handleReviewRoutes,
  handleProviderRoutes,
  handleWikiRoutes,
  handleIngestRoutes,
];

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
      if (!path.startsWith("/api/")) return await serveStatic(path);

      const identity = authenticate(req);
      if (method !== "GET" && method !== "HEAD") {
        validateMutation(req, url, path);
      }

      const context = {
        db,
        identity,
        ingestDependencies,
        ingestGate,
        method,
        path,
        providerSettings,
        req,
        requestId,
        resolveProviders,
        semanticSearchGate,
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
