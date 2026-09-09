// Central configuration — deployment and provider choices may be overridden
// through the environment. Product behaviour and safety bounds stay fixed so
// ordinary installations do not expose low-level tuning controls.

import { join, posix, win32 } from "node:path";

import {
  defaultAppDataDirectory,
  defaultVaultDirectory,
  type PlatformEnvironment,
} from "./platform_paths.ts";

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

const configuredVault = envValue("SYNTHESIS_VAULT");
const platformEnvironment: PlatformEnvironment = {
  APPDATA: envValue("APPDATA"),
  HOME: envValue("HOME"),
  HOMEDRIVE: envValue("HOMEDRIVE"),
  HOMEPATH: envValue("HOMEPATH"),
  USERPROFILE: envValue("USERPROFILE"),
  XDG_CONFIG_HOME: envValue("XDG_CONFIG_HOME"),
};

const SAFETY_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  maxUploadBytes: 25 * 1024 * 1024,
  maxPastedTextChars: 250_000,
  maxTitleChars: 200,
  maxSearchChars: 500,
  maxTranscriptChars: 500_000,
  maxSubtitleBytes: 10 * 1024 * 1024,
  ytDlpTimeoutMs: 2 * 60 * 1000,
  modelTimeoutMs: 10 * 60 * 1000,
  pdfParseTimeoutMs: 30 * 1000,
  ingestQueueSize: 4,
};

const MODEL_SETTINGS = {
  temperature: 0.1,
  extractTemperature: 0,
  consolidateTemperature: 0.1,
  integrateTemperature: 0.1,
  reasoningEffort: "none" as const,
  extractMaxTokens: 2_000,
  consolidateMaxTokens: 4_000,
  integrateMaxTokens: 2_000,
  rewriteMaxTokens: 2_000,
  maxTokens: 800,
};

const INGEST_SETTINGS = {
  maxChars: 12_000,
  overlap: 500,
  playlistEnabled: true,
  maxPlaylistItems: 10,
  maxManualQueueItems: 20,
  maxTrustedBatchItems: 100,
  maxPdfPages: 500,
};

const PRESENTATION_SETTINGS = {
  semanticLinksPerPage: 8,
  visibleSemanticNeighbors: 3,
  searchResultLimit: 20,
  labelZoomThreshold: 1.5,
};

function defaultAppDataDir(): string {
  const explicit = envValue("SYNTHESIS_APP_DATA");
  if (explicit) return explicit;
  return defaultAppDataDirectory(Deno.build.os, platformEnvironment);
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
  vaultDir: configuredVault?.trim()
    ? configuredVault
    : defaultVaultDirectory(Deno.build.os, platformEnvironment),
  appDataDir: defaultAppDataDir(),
  host: env("SYNTHESIS_HOST", "127.0.0.1"),
  port: Math.max(1, Math.min(65535, envInt("SYNTHESIS_PORT", 8000))),

  security: {
    publicOrigin: envOrigin("SYNTHESIS_PUBLIC_ORIGIN"),
    trustProxyAuth: envBool("SYNTHESIS_TRUST_PROXY_AUTH", false),
    allowedEmails: envCsv("SYNTHESIS_ALLOWED_EMAILS"),
    ingesterEmails: envCsv("SYNTHESIS_INGESTER_EMAILS"),
    ...SAFETY_LIMITS,
  },

  llm: {
    apiBase: env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    apiKey: env("SYNTHESIS_API_KEY", "ollama"),

    // Keep every knowledge-authoring role on the quality floor by default.
    // Operators can still select another compatible provider model explicitly.
    extractModel: env("SYNTHESIS_EXTRACT_MODEL", "qwen3.6:27b"),
    consolidateModel: env("SYNTHESIS_CONSOLIDATE_MODEL", "qwen3.6:27b"),
    integrateModel: env("SYNTHESIS_INTEGRATE_MODEL", "qwen3.6:27b"),
    rewriteModel: env("SYNTHESIS_REWRITE_MODEL", "qwen3.6:27b"),

    ...MODEL_SETTINGS,
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
    ...INGEST_SETTINGS,
    ytDlpPath: env("SYNTHESIS_YT_DLP_PATH", defaultYtDlpExecutable()),
    ytDlpLang: env("SYNTHESIS_SUBTITLES_LANG", "en"),
  },

  link: {
    k: PRESENTATION_SETTINGS.semanticLinksPerPage,
    visibleNeighbors: PRESENTATION_SETTINGS.visibleSemanticNeighbors,
  },

  search: {
    resultLimit: PRESENTATION_SETTINGS.searchResultLimit,
  },

  ui: {
    labelZoomThreshold: PRESENTATION_SETTINGS.labelZoomThreshold,
  },

  build: {
    version: "0.2.1",
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
  return join(config.vaultDir, "synthesis.db");
}

export function notesDir(): string {
  return join(config.vaultDir, "notes");
}

export function sourcesDir(): string {
  return join(config.vaultDir, "sources");
}

export function providerSettingsPath(): string {
  return join(config.appDataDir, "provider-profile.json");
}

export function providerUsagePath(): string {
  return join(config.appDataDir, "provider-usage.json");
}
