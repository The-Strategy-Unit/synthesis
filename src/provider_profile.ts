/**
 * A provider profile contains configuration that is safe to persist locally.
 * API keys deliberately do not belong to this type: they are held separately
 * by the platform credential store.
 */
export interface ProviderProfile {
  id: "default";
  displayName: string;
  llm: ProviderEndpoint;
  embedding: EmbeddingEndpoint;
}

export interface ProviderEndpoint {
  apiBase: string;
  model: string;
}

export interface EmbeddingEndpoint extends ProviderEndpoint {
  dimensions: number;
}

export class ProviderProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProfileError";
  }
}

const MAX_NAME_LENGTH = 80;
const MAX_MODEL_LENGTH = 200;

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new ProviderProfileError(`${label} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new ProviderProfileError(
      `${label} must be 1-${maxLength} characters`,
    );
  }
  return text;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "127.0.0.1";
}

/** Normalise a safe OpenAI-compatible base URL. */
export function validateApiBase(value: unknown, label: string): string {
  const text = requiredText(value, label, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProviderProfileError(`${label} must be an absolute URL`);
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderProfileError(
      `${label} must not contain credentials, a query, or a fragment`,
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new ProviderProfileError(
      `${label} must use HTTPS, except for a loopback provider`,
    );
  }
  if (url.pathname !== "/v1" && url.pathname !== "/v1/") {
    throw new ProviderProfileError(`${label} must end with /v1`);
  }
  return url.origin + "/v1";
}

function validateEndpoint(value: unknown, label: string): ProviderEndpoint {
  if (!value || typeof value !== "object") {
    throw new ProviderProfileError(`${label} must be an object`);
  }
  const endpoint = value as Record<string, unknown>;
  return {
    apiBase: validateApiBase(endpoint.apiBase, `${label}.apiBase`),
    model: requiredText(endpoint.model, `${label}.model`, MAX_MODEL_LENGTH),
  };
}

/** Validate and redact an untrusted settings payload before persistence. */
export function validateProviderProfile(value: unknown): ProviderProfile {
  if (!value || typeof value !== "object") {
    throw new ProviderProfileError("Provider profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  const embedding = validateEndpoint(profile.embedding, "embedding");
  const dimensions = profile.embedding && typeof profile.embedding === "object"
    ? (profile.embedding as Record<string, unknown>).dimensions
    : undefined;
  if (
    !Number.isInteger(dimensions) || (dimensions as number) < 64 ||
    (dimensions as number) > 32_768
  ) {
    throw new ProviderProfileError(
      "embedding.dimensions must be an integer from 64 to 32768",
    );
  }

  return {
    id: "default",
    displayName: requiredText(
      profile.displayName,
      "displayName",
      MAX_NAME_LENGTH,
    ),
    llm: validateEndpoint(profile.llm, "llm"),
    embedding: { ...embedding, dimensions: dimensions as number },
  };
}
