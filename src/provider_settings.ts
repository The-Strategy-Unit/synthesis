import { config } from "./config.ts";
import {
  type ProviderProfile,
  validateProviderProfile,
} from "./provider_profile.ts";
import type { ProviderProfileStore } from "./provider_profile_store.ts";
import {
  type ActiveProviders,
  diagnoseProviders,
  ProviderRuntimeError,
} from "./provider_runtime.ts";
import type { ProviderSecret, SecretStore } from "./secret_store.ts";

type Profiles = Pick<ProviderProfileStore, "load" | "save">;
type SecretStoreFactory = () => Promise<SecretStore>;

export interface ProviderSettingsStatus {
  configured: boolean;
  profile: ProviderProfile | null;
  llmKeyStored: boolean;
  embeddingKeyStored: boolean;
}

export interface ProviderSettingsInput {
  profile: unknown;
  llmApiKey: unknown;
  embeddingApiKey: unknown;
}

export class ProviderSettingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSettingsInputError";
  }
}

function apiKey(
  value: unknown,
  label: string,
  stored: string | null,
): string {
  if (value === undefined || value === null || value === "") {
    if (stored) return stored;
    throw new ProviderSettingsInputError(`${label} is required`);
  }
  if (typeof value !== "string") {
    throw new ProviderSettingsInputError(`${label} must be a string`);
  }
  const key = value.trim();
  const hasControl = [...key].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
  if (!key || key.length > 4_096 || hasControl) {
    throw new ProviderSettingsInputError(
      `${label} must contain 1-4096 printable characters`,
    );
  }
  return key;
}

async function secretStore(
  secrets: SecretStore | SecretStoreFactory,
): Promise<SecretStore> {
  return typeof secrets === "function" ? await secrets() : secrets;
}

async function restoreSecret(
  store: SecretStore,
  name: ProviderSecret,
  previous: string | null,
): Promise<void> {
  if (previous === null) await store.delete(name);
  else await store.set(name, previous);
}

function activeProviders(
  profile: ProviderProfile,
  llmApiKey: string,
  embeddingApiKey: string,
): ActiveProviders {
  return {
    source: "profile",
    llm: {
      apiBase: profile.llm.apiBase,
      apiKey: llmApiKey,
      extractModel: profile.llm.model,
      consolidateModel: profile.llm.model,
      integrateModel: profile.llm.model,
      rewriteModel: profile.llm.model,
    },
    embedding: {
      apiBase: profile.embedding.apiBase,
      apiKey: embeddingApiKey,
      model: profile.embedding.model,
    },
  };
}

function diagnosticsFailure(
  diagnostics: Awaited<ReturnType<typeof diagnoseProviders>>,
): ProviderRuntimeError {
  const issues = [
    diagnostics.chat.missingModels.length
      ? `missing chat model(s): ${diagnostics.chat.missingModels.join(", ")}`
      : diagnostics.chat.probe.error,
    diagnostics.embedding.missingModels.length
      ? `missing embedding model(s): ${
        diagnostics.embedding.missingModels.join(", ")
      }`
      : diagnostics.embedding.probe.error,
  ].filter((issue): issue is string => Boolean(issue));
  return new ProviderRuntimeError(
    `Provider compatibility check failed${
      issues.length ? `: ${issues.join("; ")}` : ""
    }`,
  );
}

export async function providerSettingsStatus(
  profiles: Profiles,
  secrets: SecretStore | SecretStoreFactory,
): Promise<ProviderSettingsStatus> {
  const profile = await profiles.load();
  if (!profile) {
    return {
      configured: false,
      profile: null,
      llmKeyStored: false,
      embeddingKeyStored: false,
    };
  }
  const store = await secretStore(secrets);
  const [llmKey, embeddingKey] = await Promise.all([
    store.get("llm"),
    store.get("embedding"),
  ]);
  return {
    configured: Boolean(llmKey && embeddingKey),
    profile,
    llmKeyStored: Boolean(llmKey),
    embeddingKeyStored: Boolean(embeddingKey),
  };
}

export async function configureProviders(
  profiles: Profiles,
  secrets: SecretStore | SecretStoreFactory,
  input: ProviderSettingsInput,
): Promise<ProviderSettingsStatus> {
  const profile = validateProviderProfile(input.profile);
  if (profile.embedding.dimensions !== config.embed.dimensions) {
    throw new ProviderSettingsInputError(
      `embedding.dimensions must match this vault (${config.embed.dimensions})`,
    );
  }
  const store = await secretStore(secrets);
  const [previousLlmKey, previousEmbeddingKey] = await Promise.all([
    store.get("llm"),
    store.get("embedding"),
  ]);
  const llmKey = apiKey(input.llmApiKey, "llmApiKey", previousLlmKey);
  const embeddingKey = apiKey(
    input.embeddingApiKey,
    "embeddingApiKey",
    previousEmbeddingKey,
  );
  const diagnostics = await diagnoseProviders(
    activeProviders(profile, llmKey, embeddingKey),
  );
  if (!diagnostics.ready) throw diagnosticsFailure(diagnostics);

  try {
    await store.set("llm", llmKey);
    await store.set("embedding", embeddingKey);
    await profiles.save(profile);
  } catch (error) {
    await Promise.all([
      restoreSecret(store, "llm", previousLlmKey),
      restoreSecret(store, "embedding", previousEmbeddingKey),
    ]).catch(() => undefined);
    throw error;
  }
  return {
    configured: true,
    profile,
    llmKeyStored: true,
    embeddingKeyStored: true,
  };
}
