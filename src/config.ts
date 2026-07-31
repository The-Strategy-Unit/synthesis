// Central configuration — all settings in one place.
// Values can be overridden via environment variables, with validation.

type ReasoningEffort = "high" | "medium" | "low" | "max" | "none";

function env(key: string, fallback: string): string {
  return Deno.env.get(key) ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(Deno.env.get(key) ?? "", 10);
  return isNaN(v) ? fallback : v;
}

function envClamped(
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const v = parseFloat(Deno.env.get(key) ?? "");
  return isNaN(v) ? fallback : Math.min(max, Math.max(min, v));
}

function envEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = Deno.env.get(key) as T | undefined;
  return v && allowed.includes(v) ? v : fallback;
}

const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";

export const config = {
  vaultDir: env("SYNTHESIS_VAULT", `${home}/Synthesis`),
  port: Math.max(1, Math.min(65535, envInt("SYNTHESIS_PORT", 8000))),

  llm: {
    apiBase: env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    apiKey: env("SYNTHESIS_API_KEY", "ollama"),
    model: env("SYNTHESIS_LLM_MODEL", "qwen3.6:27b"),
    summaryModel: env("SYNTHESIS_SUMMARY_MODEL", "qwen3.5:9b"),

    temperature: envClamped("SYNTHESIS_LLM_TEMPERATURE", 0, 2, 0.1),
    summariseTemperature: envClamped(
      "SYNTHESIS_SUMMARY_TEMPERATURE",
      0,
      2,
      0.2,
    ),
    integrateTemperature: envClamped(
      "SYNTHESIS_INTEGRATE_TEMPERATURE",
      0,
      2,
      0.1,
    ),

    reasoningEffort: envEnum(
      "SYNTHESIS_REASONING_EFFORT",
      ["high", "medium", "low", "max", "none"] as const,
      "none" as ReasoningEffort,
    ),

    maxTokens: Math.max(256, envInt("SYNTHESIS_MAX_TOKENS", 800)),
  },

  embed: {
    apiBase: env(
      "SYNTHESIS_EMBED_API_BASE",
      env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    ),
    apiKey: env("SYNTHESIS_EMBED_API_KEY", env("SYNTHESIS_API_KEY", "ollama")),
    model: env("SYNTHESIS_EMBED_MODEL", "qwen3-embedding:8b"),
    dimensions: Math.max(64, envInt("SYNTHESIS_EMBED_DIMENSIONS", 4096)),
  },

  ingest: {
    maxChars: Math.max(1000, envInt("SYNTHESIS_MAX_CHARS", 12000)),
    overlap: envClamped("SYNTHESIS_CHUNK_OVERLAP", 0, 2000, 500),
    ytDlpLang: env("SYNTHESIS_SUBTITLES_LANG", "en"),
  },

  link: {
    similarityThreshold: envClamped("SYNTHESIS_LINK_THRESHOLD", 0, 1, 0.75),
    k: Math.max(1, envInt("SYNTHESIS_LINK_K", 50)),
  },

  search: {
    resultLimit: Math.max(1, envInt("SYNTHESIS_SEARCH_LIMIT", 20)),
  },

  ui: {
    labelZoomThreshold: envClamped(
      "SYNTHESIS_LABEL_ZOOM_THRESHOLD",
      0,
      10,
      1.5,
    ),
    sliderMin: envClamped("SYNTHESIS_SLIDER_MIN", 0, 1, 0),
    sliderMax: envClamped("SYNTHESIS_SLIDER_MAX", 0, 1, 1),
    sliderStep: envClamped("SYNTHESIS_SLIDER_STEP", 0.001, 1, 0.025),
  },

  build: {
    version: "0.1.0",
    llmModel: env("SYNTHESIS_LLM_MODEL", "qwen3.6:27b"),
    embedModel: env("SYNTHESIS_EMBED_MODEL", "qwen3-embedding:8b"),
  },
};

export function dbPath(): string {
  return `${config.vaultDir}/synthesis.db`;
}

export function notesDir(): string {
  return `${config.vaultDir}/notes`;
}
