// Central configuration — all settings in one place.
// Values can be overridden via environment variables, with validation.

import { posix, win32 } from "node:path";

type ReasoningEffort = "high" | "medium" | "low" | "max" | "none";

function envValue(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return undefined;
    throw error;
  }
}

function env(key: string, fallback: string): string {
  return envValue(key) ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(envValue(key) ?? "", 10);
  return isNaN(v) ? fallback : v;
}

function envIntClamped(
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.min(max, Math.max(min, envInt(key, fallback)));
}

function envBool(key: string, fallback: boolean): boolean {
  const value = envValue(key)?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${key} must be a boolean`);
}

function envCsv(key: string): string[] {
  const values = (envValue(key) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(values)];
}

function envOrigin(key: string): string | undefined {
  const value = envValue(key)?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.replace(/\/$/, "") !== url.origin
  ) {
    throw new Error(`${key} must contain only an HTTP(S) scheme and host`);
  }
  return url.origin;
}

function envClamped(
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const v = parseFloat(envValue(key) ?? "");
  return isNaN(v) ? fallback : Math.min(max, Math.max(min, v));
}

function envEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = envValue(key) as T | undefined;
  return v && allowed.includes(v) ? v : fallback;
}

const home = envValue("HOME") ?? envValue("USERPROFILE") ?? ".";

function defaultAppDataDir(): string {
  const explicit = envValue("SYNTHESIS_APP_DATA");
  if (explicit) return explicit;
  switch (Deno.build.os) {
    case "windows":
      return `${envValue("APPDATA") ?? home}/Synthesis`;
    case "darwin":
      return `${home}/Library/Application Support/Synthesis`;
    default:
      return `${envValue("XDG_CONFIG_HOME") ?? `${home}/.config`}/synthesis`;
  }
}

export function defaultYtDlpExecutable(
  os: typeof Deno.build.os = Deno.build.os,
  executablePath: string = Deno.execPath(),
  isFile: (path: string) => boolean = (path) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  },
): string {
  const paths = os === "windows" ? win32 : posix;
  const fileName = os === "windows" ? "yt-dlp.exe" : "yt-dlp";
  const adjacent = paths.join(paths.dirname(executablePath), fileName);
  return isFile(adjacent) ? adjacent : fileName;
}

export const config = {
  vaultDir: env("SYNTHESIS_VAULT", `${home}/Synthesis`),
  appDataDir: defaultAppDataDir(),
  host: env("SYNTHESIS_HOST", "127.0.0.1"),
  port: Math.max(1, Math.min(65535, envInt("SYNTHESIS_PORT", 8000))),

  security: {
    publicOrigin: envOrigin("SYNTHESIS_PUBLIC_ORIGIN"),
    trustProxyAuth: envBool("SYNTHESIS_TRUST_PROXY_AUTH", false),
    allowedEmails: envCsv("SYNTHESIS_ALLOWED_EMAILS"),
    ingesterEmails: envCsv("SYNTHESIS_INGESTER_EMAILS"),
    maxBodyBytes: envIntClamped(
      "SYNTHESIS_MAX_BODY_BYTES",
      1024,
      10 * 1024 * 1024,
      1024 * 1024,
    ),
    maxUploadBytes: envIntClamped(
      "SYNTHESIS_MAX_UPLOAD_BYTES",
      1024 * 1024,
      100 * 1024 * 1024,
      25 * 1024 * 1024,
    ),
    maxPastedTextChars: envIntClamped(
      "SYNTHESIS_MAX_PASTED_TEXT_CHARS",
      1000,
      1_000_000,
      250_000,
    ),
    maxTitleChars: envIntClamped(
      "SYNTHESIS_MAX_TITLE_CHARS",
      20,
      1000,
      200,
    ),
    maxSearchChars: envIntClamped(
      "SYNTHESIS_MAX_SEARCH_CHARS",
      20,
      5000,
      500,
    ),
    maxTranscriptChars: envIntClamped(
      "SYNTHESIS_MAX_TRANSCRIPT_CHARS",
      1000,
      2_000_000,
      500_000,
    ),
    maxSubtitleBytes: envIntClamped(
      "SYNTHESIS_MAX_SUBTITLE_BYTES",
      1024 * 1024,
      100 * 1024 * 1024,
      10 * 1024 * 1024,
    ),
    ytDlpTimeoutMs: envIntClamped(
      "SYNTHESIS_YT_DLP_TIMEOUT_MS",
      5000,
      30 * 60 * 1000,
      2 * 60 * 1000,
    ),
    modelTimeoutMs: envIntClamped(
      "SYNTHESIS_MODEL_TIMEOUT_MS",
      5000,
      30 * 60 * 1000,
      10 * 60 * 1000,
    ),
    pdfParseTimeoutMs: envIntClamped(
      "SYNTHESIS_PDF_PARSE_TIMEOUT_MS",
      1000,
      5 * 60 * 1000,
      30 * 1000,
    ),
    ingestQueueSize: envIntClamped(
      "SYNTHESIS_INGEST_QUEUE_SIZE",
      0,
      100,
      4,
    ),
    perUserDailyJobs: envIntClamped(
      "SYNTHESIS_PER_USER_DAILY_JOBS",
      1,
      10_000,
      5,
    ),
    globalDailyJobs: envIntClamped(
      "SYNTHESIS_GLOBAL_DAILY_JOBS",
      1,
      100_000,
      20,
    ),
    semanticSearchesPerMinute: envIntClamped(
      "SYNTHESIS_SEMANTIC_SEARCHES_PER_MINUTE",
      1,
      1_000,
      5,
    ),
  },

  llm: {
    apiBase: env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    apiKey: env("SYNTHESIS_API_KEY", "ollama"),

    // Keep bulk extraction responsive while using the quality-first model for
    // editorial and cross-source synthesis decisions.
    extractModel: env("SYNTHESIS_EXTRACT_MODEL", "qwen3.5:9b"),
    consolidateModel: env("SYNTHESIS_CONSOLIDATE_MODEL", "qwen3.5:122b"),
    integrateModel: env("SYNTHESIS_INTEGRATE_MODEL", "qwen3.5:122b"),
    rewriteModel: env("SYNTHESIS_REWRITE_MODEL", "qwen3.5:122b"),

    temperature: envClamped("SYNTHESIS_LLM_TEMPERATURE", 0, 2, 0.1),
    extractTemperature: envClamped("SYNTHESIS_EXTRACT_TEMPERATURE", 0, 2, 0),
    consolidateTemperature: envClamped(
      "SYNTHESIS_CONSOLIDATE_TEMPERATURE",
      0,
      2,
      0.1,
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

    extractMaxTokens: Math.max(
      256,
      envInt("SYNTHESIS_EXTRACT_MAX_TOKENS", 2000),
    ),
    consolidateMaxTokens: Math.max(
      256,
      envInt("SYNTHESIS_CONSOLIDATE_MAX_TOKENS", 4000),
    ),
    integrateMaxTokens: Math.max(
      256,
      envInt("SYNTHESIS_INTEGRATE_MAX_TOKENS", 2000),
    ),
    rewriteMaxTokens: Math.max(
      256,
      envInt("SYNTHESIS_REWRITE_MAX_TOKENS", 2000),
    ),
    maxTokens: Math.max(256, envInt("SYNTHESIS_MAX_TOKENS", 800)),
  },

  embed: {
    apiBase: env(
      "SYNTHESIS_EMBED_API_BASE",
      env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    ),
    apiKey: env("SYNTHESIS_EMBED_API_KEY", env("SYNTHESIS_API_KEY", "ollama")),
    model: env(
      "SYNTHESIS_EMBED_MODEL",
      "nomic-embed-text-v2-moe:latest",
    ),
    dimensions: Math.max(64, envInt("SYNTHESIS_EMBED_DIMENSIONS", 768)),
  },

  ingest: {
    maxChars: Math.max(1000, envInt("SYNTHESIS_MAX_CHARS", 12000)),
    overlap: envClamped("SYNTHESIS_CHUNK_OVERLAP", 0, 2000, 500),
    ytDlpPath: env("SYNTHESIS_YT_DLP_PATH", defaultYtDlpExecutable()),
    ytDlpLang: env("SYNTHESIS_SUBTITLES_LANG", "en"),
    playlistEnabled: envBool("SYNTHESIS_PLAYLIST_ENABLED", true),
    maxPlaylistItems: envIntClamped(
      "SYNTHESIS_MAX_PLAYLIST_ITEMS",
      1,
      100,
      10,
    ),
    maxTrustedBatchItems: envIntClamped(
      "SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS",
      1,
      100,
      100,
    ),
    maxPdfPages: envIntClamped(
      "SYNTHESIS_MAX_PDF_PAGES",
      1,
      5000,
      500,
    ),
  },

  link: {
    k: envIntClamped("SYNTHESIS_LINK_K", 1, 32, 8),
    visibleNeighbors: envIntClamped(
      "SYNTHESIS_GRAPH_NEIGHBORS",
      0,
      32,
      3,
    ),
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
  },

  build: {
    version: "0.1.0",
  },
};

export function configuredModelNames(): string[] {
  return [
    ...new Set([
      config.llm.extractModel,
      config.llm.consolidateModel,
      config.llm.integrateModel,
      config.llm.rewriteModel,
      config.embed.model,
    ]),
  ];
}

export function dbPath(): string {
  return `${config.vaultDir}/synthesis.db`;
}

export function notesDir(): string {
  return `${config.vaultDir}/notes`;
}

export function sourcesDir(): string {
  return `${config.vaultDir}/sources`;
}

export function providerSettingsPath(): string {
  return `${config.appDataDir}/provider-profile.json`;
}
