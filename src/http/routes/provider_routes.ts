import { config } from "../../app/config.ts";
import { ProviderProfileError } from "../../provider/provider_profile.ts";
import {
  type ActiveProviders,
  checkProviderReadiness,
  diagnoseProviders,
  embeddingIdentity,
  environmentProviders,
  providerMode,
  ProviderRuntimeError,
} from "../../provider/provider_runtime.ts";
import {
  configureProviders,
  ProviderSettingsInputError,
  providerSettingsStatus,
} from "../../provider/provider_settings.ts";
import type { ApiRoute } from "../route_context.ts";
import {
  ApiError,
  errorResponse,
  json,
  logFailure,
  readJson,
  requireIngester,
  semanticIndexView,
} from "../support.ts";

export const handleProviderRoutes: ApiRoute = async (context) => {
  const {
    db,
    identity,
    method,
    path,
    providerSettings,
    req,
    requestId,
    resolveProviders,
  } = context;

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
        semanticIndex: semanticIndexView(db.search.semanticIndexStatus(
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
      const semanticIndex = semanticIndexView(db.search.activateSemanticIndex(
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
};
