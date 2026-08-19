#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform test runner
 * Resolves correct paths for the current OS before running tests
 */

import { config } from "../src/config.ts";

const vaultDir = config.vaultDir;
const tempDir = (() => {
  switch (Deno.build.os) {
    case "windows":
      return Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp";
    default:
      return Deno.env.get("TMPDIR") ?? "/tmp";
  }
})();

const allowedEnv = [
  "CI",
  "DISABLE_SYSTEM_FONTS_LOAD",
  "FORCE_COLOR",
  "HOME",
  "TERM",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYNTHESIS_ALLOWED_EMAILS",
  "SYNTHESIS_API_BASE",
  "SYNTHESIS_API_KEY",
  "SYNTHESIS_CHUNK_OVERLAP",
  "SYNTHESIS_CONSOLIDATE_MAX_TOKENS",
  "SYNTHESIS_CONSOLIDATE_MODEL",
  "SYNTHESIS_CONSOLIDATE_TEMPERATURE",
  "SYNTHESIS_EMBED_API_BASE",
  "SYNTHESIS_EMBED_API_KEY",
  "SYNTHESIS_EMBED_DIMENSIONS",
  "SYNTHESIS_EMBED_MODEL",
  "SYNTHESIS_EXTRACT_MAX_TOKENS",
  "SYNTHESIS_EXTRACT_MODEL",
  "SYNTHESIS_EXTRACT_TEMPERATURE",
  "SYNTHESIS_GLOBAL_DAILY_JOBS",
  "SYNTHESIS_GRAPH_NEIGHBORS",
  "SYNTHESIS_HOST",
  "SYNTHESIS_INGESTER_EMAILS",
  "SYNTHESIS_INGEST_QUEUE_SIZE",
  "SYNTHESIS_INTEGRATE_MAX_TOKENS",
  "SYNTHESIS_INTEGRATE_MODEL",
  "SYNTHESIS_INTEGRATE_TEMPERATURE",
  "SYNTHESIS_LABEL_ZOOM_THRESHOLD",
  "SYNTHESIS_LINK_K",
  "SYNTHESIS_LLM_MODEL",
  "SYNTHESIS_LLM_TEMPERATURE",
  "SYNTHESIS_MAX_BODY_BYTES",
  "SYNTHESIS_MAX_CHARS",
  "SYNTHESIS_MAX_PASTED_TEXT_CHARS",
  "SYNTHESIS_MAX_PLAYLIST_ITEMS",
  "SYNTHESIS_MAX_SEARCH_CHARS",
  "SYNTHESIS_MAX_TITLE_CHARS",
  "SYNTHESIS_MAX_TOKENS",
  "SYNTHESIS_MAX_TRANSCRIPT_CHARS",
  "SYNTHESIS_MODEL_TIMEOUT_MS",
  "SYNTHESIS_PER_USER_DAILY_JOBS",
  "SYNTHESIS_PLAYLIST_ENABLED",
  "SYNTHESIS_PORT",
  "SYNTHESIS_PUBLIC_ORIGIN",
  "SYNTHESIS_REASONING_EFFORT",
  "SYNTHESIS_REWRITE_MAX_TOKENS",
  "SYNTHESIS_REWRITE_MODEL",
  "SYNTHESIS_SEARCH_LIMIT",
  "SYNTHESIS_SEMANTIC_SEARCHES_PER_MINUTE",
  "SYNTHESIS_SUBTITLES_LANG",
  "SYNTHESIS_TRUST_PROXY_AUTH",
  "SYNTHESIS_VAULT",
  "SYNTHESIS_YT_DLP_TIMEOUT_MS",
].join(",");

const cmd = new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "--ignore-env=NAPI_RS_FORCE_WASI,NAPI_RS_NATIVE_LIBRARY_PATH",
    "--allow-ffi",
    `--allow-read=web,${vaultDir},${tempDir}${
      Deno.build.os === "linux" ? ",/usr/bin/ldd" : ""
    }`,
    `--allow-write=${tempDir}`,
    `--allow-env=${allowedEnv}`,
    "--allow-scripts",
    "src/",
  ],
  env: { DISABLE_SYSTEM_FONTS_LOAD: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const status = await cmd.spawn().status;
Deno.exit(status.code);
