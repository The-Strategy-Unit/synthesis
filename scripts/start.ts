#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform start script for Synthesis
 * Set SYNTHESIS_WATCH=true for development mode with auto-reload
 */

import { config } from "../src/config.ts";

const vaultDir = config.vaultDir;
const port = config.port;
const isDev = Deno.env.get("SYNTHESIS_WATCH") === "true";

function frontendBundleCommand(watch = false): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      ...(watch ? ["--watch"] : []),
      "--platform",
      "browser",
      "--output",
      "web/app.bundle.js",
      "web/app.js",
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function bundleFrontend(): Promise<void> {
  console.log("Building frontend...");
  const bundle = frontendBundleCommand();
  const status = await bundle.spawn().status;
  if (!status.success) {
    throw new Error("Frontend bundle failed; server was not started.");
  }
}

await bundleFrontend();
const frontendWatcher = isDev ? frontendBundleCommand(true).spawn() : undefined;

function envBool(key: string, fallback: boolean): boolean {
  const value = Deno.env.get(key)?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${key} must be a boolean`);
}

const openBrowser = envBool("SYNTHESIS_OPEN_BROWSER", true);

const os = Deno.build.os;
const bundledYtDlpPath = os === "windows" ? "./yt-dlp.exe" : "./yt-dlp";
const configuredYtDlpPath = Deno.env.get("SYNTHESIS_YT_DLP_PATH")?.trim();
let bundledYtDlpExists = false;
try {
  bundledYtDlpExists = (await Deno.stat(bundledYtDlpPath)).isFile;
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
const ytDlpPath = configuredYtDlpPath ||
  (bundledYtDlpExists ? bundledYtDlpPath : "yt-dlp");
let tempDir: string;

switch (os) {
  case "windows":
    tempDir = Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\temp";
    break;
  case "darwin":
    tempDir = Deno.env.get("TMPDIR") ?? "/tmp";
    break;
  case "linux":
    tempDir = Deno.env.get("TMPDIR") ?? "/tmp";
    break;
  default:
    tempDir = Deno.env.get("TMPDIR") ?? "/tmp";
}

function hostPort(hostname: string, port: string | number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `${host}:${port}`;
}

const allowedEnv = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYNTHESIS_ALLOWED_EMAILS",
  "SYNTHESIS_APP_DATA",
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
  "SYNTHESIS_HOST",
  "SYNTHESIS_INGESTER_EMAILS",
  "SYNTHESIS_INGEST_QUEUE_SIZE",
  "SYNTHESIS_INTEGRATE_MAX_TOKENS",
  "SYNTHESIS_INTEGRATE_MODEL",
  "SYNTHESIS_INTEGRATE_TEMPERATURE",
  "SYNTHESIS_LABEL_ZOOM_THRESHOLD",
  "SYNTHESIS_LINK_K",
  "SYNTHESIS_LINK_THRESHOLD",
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
  "SYNTHESIS_OPEN_BROWSER",
  "SYNTHESIS_PER_USER_DAILY_JOBS",
  "SYNTHESIS_PLAYLIST_ENABLED",
  "SYNTHESIS_PORT",
  "SYNTHESIS_PUBLIC_ORIGIN",
  "SYNTHESIS_REASONING_EFFORT",
  "SYNTHESIS_REWRITE_MAX_TOKENS",
  "SYNTHESIS_REWRITE_MODEL",
  "SYNTHESIS_SEARCH_LIMIT",
  "SYNTHESIS_SEMANTIC_SEARCHES_PER_MINUTE",
  "SYNTHESIS_SLIDER_MAX",
  "SYNTHESIS_SLIDER_MIN",
  "SYNTHESIS_SLIDER_STEP",
  "SYNTHESIS_SUBTITLES_LANG",
  "SYNTHESIS_TRUST_PROXY_AUTH",
  "SYNTHESIS_VAULT",
  "SYNTHESIS_WATCH",
  "SYNTHESIS_YT_DLP_PATH",
  "SYNTHESIS_YT_DLP_TIMEOUT_MS",
  "XDG_CONFIG_HOME",
].join(",");

const args = ["run"];
if (isDev) args.push("--watch");
args.push(
  "--frozen",
  "--allow-net",
  "--allow-ffi",
  `--allow-read=web,${vaultDir},${config.appDataDir},${tempDir}`,
  `--allow-write=${vaultDir},${config.appDataDir},${tempDir}`,
  `--allow-run=${ytDlpPath}`,
  `--allow-env=${allowedEnv}`,
  "main.ts",
);

const cmd = new Deno.Command(Deno.execPath(), {
  args,
  env: { SYNTHESIS_YT_DLP_PATH: ytDlpPath },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const process = cmd.spawn();

if (openBrowser) {
  // Open browser (server typically starts within 1-2s).
  const browserHost = ["0.0.0.0", "::"].includes(config.host)
    ? "localhost"
    : config.host;
  const url = `http://${hostPort(browserHost, port)}`;
  const opener = os === "windows"
    ? ["cmd", "/c", "start", url]
    : os === "darwin"
    ? ["open", url]
    : ["xdg-open", url];

  try {
    new Deno.Command(opener[0], {
      args: opener.slice(1),
      stdin: "null",
    }).spawn();
    console.log(`\nOpening browser: ${url}\n`);
  } catch {
    console.log(`\nOpen browser to: ${url}\n`);
  }
}

const status = await process.status;
frontendWatcher?.kill();
Deno.exit(status.code);
