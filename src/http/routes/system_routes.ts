import { config } from "../../app/config.ts";
import {
  rebuildSemanticIndex,
  validateSemanticRebuildLimit,
} from "../../catalogue/semantic_index.ts";
import { errMsg } from "../../shared/utils.ts";
import { exportVault } from "../../vault/vault_export.ts";
import {
  rebuildVaultCatalogue,
  VaultRebuildError,
} from "../../vault/vault_rebuild.ts";
import { ensureWikiSchema, saveWikiSchema } from "../../wiki/wiki_schema.ts";
import type { ApiRoute } from "../route_context.ts";
import {
  ApiError,
  json,
  readJson,
  requireIngester,
  responseHeaders,
  semanticIndexView,
} from "../support.ts";

export const handleSystemRoutes: ApiRoute = async (context) => {
  const {
    db,
    identity,
    ingestGate,
    method,
    path,
    req,
    resolveProviders,
    semanticSearchGate,
  } = context;

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
        "Set 'confirm' to 'REBUILD' to rebuild the local catalogue",
      );
    }
    const release = await ingestGate.acquire(identity, req.signal, {
      countTowardsQuota: false,
    });
    try {
      return json({ rebuild: await rebuildVaultCatalogue(db) });
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
      semanticIndex: semanticIndexView(db.search.semanticIndexStatus()),
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
};
