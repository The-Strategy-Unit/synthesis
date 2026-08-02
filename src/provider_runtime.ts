import { config } from "./config.ts";
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
): Promise<void> {
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
  await response.body?.cancel();
}
