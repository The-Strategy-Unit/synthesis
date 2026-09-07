#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform test runner
 * Resolves correct paths for the current OS before running tests
 */

import { config } from "../src/app/config.ts";

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
  "SYNTHESIS_APP_DATA",
  "SYNTHESIS_API_BASE",
  "SYNTHESIS_API_KEY",
  "SYNTHESIS_CONSOLIDATE_MODEL",
  "SYNTHESIS_EMBED_API_BASE",
  "SYNTHESIS_EMBED_API_KEY",
  "SYNTHESIS_EMBED_DIMENSIONS",
  "SYNTHESIS_EMBED_MODEL",
  "SYNTHESIS_EXTRACT_MODEL",
  "SYNTHESIS_HOST",
  "SYNTHESIS_INGESTER_EMAILS",
  "SYNTHESIS_INTEGRATE_MODEL",
  "SYNTHESIS_OPEN_BROWSER",
  "SYNTHESIS_PORT",
  "SYNTHESIS_PUBLIC_ORIGIN",
  "SYNTHESIS_REWRITE_MODEL",
  "SYNTHESIS_SUBTITLES_LANG",
  "SYNTHESIS_TRUST_PROXY_AUTH",
  "SYNTHESIS_VAULT",
  "SYNTHESIS_YT_DLP_PATH",
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
