import { config } from "./config.ts";
import { chatCompletion, parseJsonResponse } from "./llm.ts";
import type { ProviderProfileStore } from "./provider_profile_store.ts";
import type { ProviderSecret, SecretStore } from "./secret_store.ts";

export interface ActiveProviders {
  source: "environment" | "profile";
  llm: {
    apiBase: string;
    apiKey: string;
    extractModel: string;
    consolidateModel: string;
    integrateModel: string;
    rewriteModel: string;
  };
  embedding: { apiBase: string; apiKey: string; model: string };
}

export type ProviderMode = "local" | "remote";

export interface ProviderProbe {
  attempted: boolean;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface ProviderDiagnostics {
  mode: ProviderMode;
  source: ActiveProviders["source"];
  ready: boolean;
  chat: {
    apiBase: string;
    requiredModels: string[];
    missingModels: string[];
    probe: ProviderProbe;
  };
  embedding: {
    apiBase: string;
    requiredModels: string[];
    missingModels: string[];
    expectedDimensions: number;
    actualDimensions: number | null;
    probe: ProviderProbe;
  };
}

export interface ProviderReadiness {
  mode: ProviderMode;
  source: ActiveProviders["source"];
  ready: boolean;
  chat: {
    requiredModels: string[];
    missingModels: string[];
  };
  embedding: {
    requiredModels: string[];
    missingModels: string[];
  };
}

export class ProviderRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

type Profiles = Pick<ProviderProfileStore, "load">;
type SecretStoreFactory = () => Promise<SecretStore>;

function missingSecret(secret: ProviderSecret): ProviderRuntimeError {
  return new ProviderRuntimeError(
    `The ${secret} API key is missing from OS credential storage`,
  );
}

export function environmentProviders(): ActiveProviders {
  return {
    source: "environment",
    llm: {
      apiBase: config.llm.apiBase,
      apiKey: config.llm.apiKey,
      extractModel: config.llm.extractModel,
      consolidateModel: config.llm.consolidateModel,
      integrateModel: config.llm.integrateModel,
      rewriteModel: config.llm.rewriteModel,
    },
    embedding: {
      apiBase: config.embed.apiBase,
      apiKey: config.embed.apiKey,
      model: config.embed.model,
    },
  };
}

function isLoopbackApiBase(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host === "[::1]";
  } catch {
    return false;
  }
}

export function providerMode(
  providers: {
    llm: { apiBase: string };
    embedding: { apiBase: string };
  },
): ProviderMode {
  return isLoopbackApiBase(providers.llm.apiBase) &&
      isLoopbackApiBase(providers.embedding.apiBase)
    ? "local"
    : "remote";
}

/** Resolve a saved desktop profile, or preserve environment configuration. */
export async function resolveActiveProviders(
  profiles: Profiles,
  secrets: SecretStore | SecretStoreFactory,
): Promise<ActiveProviders> {
  const profile = await profiles.load();
  if (!profile) return environmentProviders();
  if (profile.embedding.dimensions !== config.embed.dimensions) {
    throw new ProviderRuntimeError(
      `Embedding dimensions (${profile.embedding.dimensions}) do not match this vault (${config.embed.dimensions})`,
    );
  }

  const store = typeof secrets === "function" ? await secrets() : secrets;
  const [llmKey, embeddingKey] = await Promise.all([
    store.get("llm"),
    store.get("embedding"),
  ]);
  if (!llmKey) throw missingSecret("llm");
  if (!embeddingKey) throw missingSecret("embedding");

  return {
    source: "profile",
    llm: {
      apiBase: profile.llm.apiBase,
      apiKey: llmKey,
      extractModel: profile.llm.model,
      consolidateModel: profile.llm.model,
      integrateModel: profile.llm.model,
      rewriteModel: profile.llm.model,
    },
    embedding: {
      apiBase: profile.embedding.apiBase,
      apiKey: embeddingKey,
      model: profile.embedding.model,
    },
  };
}

/** Verify provider credentials without sending a model-generation request. */
export async function checkProviderConnection(
  apiBase: string,
  apiKey: string,
  timeoutMs = config.security.modelTimeoutMs,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderRuntimeError("Provider connection timed out");
    }
    throw new ProviderRuntimeError("Unable to contact provider");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderRuntimeError(
      `Provider rejected connection (${response.status})`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderRuntimeError("Provider returned an invalid model list");
  }
  if (!payload || typeof payload !== "object") {
    throw new ProviderRuntimeError("Provider returned an invalid model list");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new ProviderRuntimeError("Provider returned an invalid model list");
  }
  return [
    ...new Set(data.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as Record<string, unknown>).id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    })),
  ];
}

/**
 * Check that every configured model is advertised by the provider without
 * loading a model or sending user content. This is deliberately lighter than
 * diagnostics so it is safe to run when the application starts.
 */
export async function checkProviderReadiness(
  providers: ActiveProviders,
  timeoutMs = Math.min(config.security.modelTimeoutMs, 3_000),
): Promise<ProviderReadiness> {
  const requiredChatModels = [
    ...new Set([
      providers.llm.extractModel,
      providers.llm.consolidateModel,
      providers.llm.integrateModel,
      providers.llm.rewriteModel,
    ]),
  ];
  const requiredEmbeddingModels = [providers.embedding.model];
  const sameEndpoint = providers.llm.apiBase === providers.embedding.apiBase &&
    providers.llm.apiKey === providers.embedding.apiKey;
  const [chatModels, embeddingModels] = sameEndpoint
    ? await checkProviderConnection(
      providers.llm.apiBase,
      providers.llm.apiKey,
      timeoutMs,
    ).then((models) => [models, models])
    : await Promise.all([
      checkProviderConnection(
        providers.llm.apiBase,
        providers.llm.apiKey,
        timeoutMs,
      ),
      checkProviderConnection(
        providers.embedding.apiBase,
        providers.embedding.apiKey,
        timeoutMs,
      ),
    ]);
  const chatAvailable = new Set(chatModels);
  const embeddingAvailable = new Set(embeddingModels);
  const missingChat = requiredChatModels.filter((model) =>
    !chatAvailable.has(model)
  );
  const missingEmbedding = requiredEmbeddingModels.filter((model) =>
    !embeddingAvailable.has(model)
  );
  return {
    mode: providerMode(providers),
    source: providers.source,
    ready: missingChat.length === 0 && missingEmbedding.length === 0,
    chat: {
      requiredModels: requiredChatModels,
      missingModels: missingChat,
    },
    embedding: {
      requiredModels: requiredEmbeddingModels,
      missingModels: missingEmbedding,
    },
  };
}

function skippedProbe(): ProviderProbe {
  return {
    attempted: false,
    ok: false,
    latencyMs: null,
    error: null,
  };
}

function failedProbe(startedAt: number, error: unknown): ProviderProbe {
  return {
    attempted: true,
    ok: false,
    latencyMs: Math.round(performance.now() - startedAt),
    error: error instanceof Error
      ? error.message
      : "Compatibility probe failed",
  };
}

async function probeChatProvider(
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<ProviderProbe> {
  const startedAt = performance.now();
  try {
    const content = await chatCompletion(
      apiBase,
      apiKey,
      model,
      "Return exactly one JSON object and no commentary.",
      'Reply with {"ok":true}.',
      { temperature: 0, maxTokens: 32, jsonMode: true },
    );
    const parsed = parseJsonResponse(content, "Provider chat probe");
    if (
      !parsed || typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).ok !== true
    ) {
      throw new ProviderRuntimeError(
        "Chat model did not follow the required JSON response format",
      );
    }
    return {
      attempted: true,
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      error: null,
    };
  } catch (error) {
    return failedProbe(startedAt, error);
  }
}

async function probeEmbeddingProvider(
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<{ probe: ProviderProbe; dimensions: number | null }> {
  const startedAt = performance.now();
  let dimensions: number | null = null;
  try {
    const response = await fetch(`${apiBase}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: "Synthesis provider compatibility check",
      }),
      signal: AbortSignal.timeout(config.security.modelTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderRuntimeError(
        `Embedding model rejected the compatibility check (${response.status})`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderRuntimeError(
        "Embedding model returned an invalid response",
      );
    }
    const embedding = (payload as {
      data?: Array<{ embedding?: unknown }>;
    })?.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) || embedding.length === 0 ||
      !embedding.every((value) =>
        typeof value === "number" && Number.isFinite(value)
      )
    ) {
      throw new ProviderRuntimeError(
        "Embedding model returned an invalid vector",
      );
    }
    dimensions = embedding.length;
    if (dimensions !== config.embed.dimensions) {
      throw new ProviderRuntimeError(
        `Embedding model returned ${dimensions} dimensions; this vault requires ${config.embed.dimensions}`,
      );
    }
    return {
      dimensions,
      probe: {
        attempted: true,
        ok: true,
        latencyMs: Math.round(performance.now() - startedAt),
        error: null,
      },
    };
  } catch (error) {
    return {
      dimensions,
      probe: failedProbe(startedAt, error),
    };
  }
}

export async function diagnoseProviders(
  providers: ActiveProviders,
): Promise<ProviderDiagnostics> {
  const readiness = await checkProviderReadiness(
    providers,
    config.security.modelTimeoutMs,
  );
  const missingChat = readiness.chat.missingModels;
  const missingEmbedding = readiness.embedding.missingModels;
  const [chatProbe, embeddingResult] = await Promise.all([
    missingChat.length === 0
      ? probeChatProvider(
        providers.llm.apiBase,
        providers.llm.apiKey,
        providers.llm.consolidateModel,
      )
      : Promise.resolve(skippedProbe()),
    missingEmbedding.length === 0
      ? probeEmbeddingProvider(
        providers.embedding.apiBase,
        providers.embedding.apiKey,
        providers.embedding.model,
      )
      : Promise.resolve({ probe: skippedProbe(), dimensions: null }),
  ]);
  return {
    mode: providerMode(providers),
    source: providers.source,
    ready: missingChat.length === 0 && missingEmbedding.length === 0 &&
      chatProbe.ok && embeddingResult.probe.ok,
    chat: {
      apiBase: providers.llm.apiBase,
      requiredModels: readiness.chat.requiredModels,
      missingModels: missingChat,
      probe: chatProbe,
    },
    embedding: {
      apiBase: providers.embedding.apiBase,
      requiredModels: readiness.embedding.requiredModels,
      missingModels: missingEmbedding,
      expectedDimensions: config.embed.dimensions,
      actualDimensions: embeddingResult.dimensions,
      probe: embeddingResult.probe,
    },
  };
}
