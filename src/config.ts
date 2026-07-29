// Central configuration - all settings in one place.
// Values can be overridden via environment variables.

function env(key: string, fallback: string): string {
  return Deno.env.get(key) ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = Deno.env.get(key);
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = Deno.env.get(key);
  return v ? parseFloat(v) : fallback;
}

const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";

export const config = {
  vaultDir: env("SYNTHESIS_VAULT", `${home}/Synthesis`),
  port: envInt("SYNTHESIS_PORT", 8000),

  llm: {
    apiBase: env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    apiKey: env("SYNTHESIS_API_KEY", "ollama"),
    model: env("SYNTHESIS_LLM_MODEL", "qwen3.6:27b"),
  },

  embed: {
    apiBase: env(
      "SYNTHESIS_EMBED_API_BASE",
      env("SYNTHESIS_API_BASE", "http://localhost:11434/v1"),
    ),
    apiKey: env("SYNTHESIS_EMBED_API_KEY", env("SYNTHESIS_API_KEY", "ollama")),
    model: env("SYNTHESIS_EMBED_MODEL", "qwen3-embedding:8b"),
  },

  ingest: {
    maxChars: envInt("SYNTHESIS_MAX_CHARS", 12000),
    overlap: envInt("SYNTHESIS_CHUNK_OVERLAP", 500),
    ytDlpLang: env("SYNTHESIS_SUBTITLES_LANG", "en"),
  },

  link: {
    similarityThreshold: envFloat("SYNTHESIS_LINK_THRESHOLD", 0.75),
    k: envInt("SYNTHESIS_LINK_K", 50),
  },

  search: {
    resultLimit: envInt("SYNTHESIS_SEARCH_LIMIT", 20),
  },
};

export function dbPath(): string {
  return `${config.vaultDir}/synthesis.db`;
}

export function notesDir(): string {
  return `${config.vaultDir}/notes`;
}
