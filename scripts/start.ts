#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform start script for Synthesis
 * Set SYNTHESIS_WATCH=true for development mode with auto-reload
 */

import {
  announceAndOpen,
  environmentBoolean,
  hostPort,
} from "../src/browser_launcher.ts";
import {
  cleanTrialRun,
  prepareTrialRun,
  printTrialGuide,
} from "../src/trial_vault.ts";

if (
  Deno.args.length > 1 || (Deno.args.length === 1 && Deno.args[0] !== "--trial")
) {
  throw new Error("Usage: scripts/start.ts [--trial]");
}
const trial = Deno.args[0] === "--trial" ? await prepareTrialRun() : undefined;
const { config } = await import("../src/config.ts");
const vaultDir = config.vaultDir;
const port = config.port;
const isDev = Deno.env.get("SYNTHESIS_WATCH") === "true";

const frontendBundleCommand = (watch = false): Deno.Command => {
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
};

const bundleFrontend = async (): Promise<void> => {
  console.log("Building frontend...");
  const bundle = frontendBundleCommand();
  const status = await bundle.spawn().status;
  if (!status.success) {
    throw new Error("Frontend bundle failed; server was not started.");
  }
};

const openBrowser = environmentBoolean("SYNTHESIS_OPEN_BROWSER", true);

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

const assertPortAvailable = (hostname: string, port: number): void => {
  try {
    const listener = Deno.listen({ hostname, port });
    listener.close();
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(
        `Synthesis could not start: ${
          hostPort(hostname, port)
        } is already in use.`,
      );
      console.error(
        "Stop the existing process or set SYNTHESIS_PORT to another port.",
      );
      Deno.exit(1);
    }
    throw error;
  }
};

assertPortAvailable(config.host, port);
await bundleFrontend();
const frontendWatcher = isDev ? frontendBundleCommand(true).spawn() : undefined;

const allowedEnv = [
  "CI",
  "DISABLE_SYSTEM_FONTS_LOAD",
  "FORCE_COLOR",
  "HOME",
  "NO_COLOR",
  "TERM",
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
  "SYNTHESIS_GRAPH_NEIGHBORS",
  "SYNTHESIS_HOST",
  "SYNTHESIS_INGESTER_EMAILS",
  "SYNTHESIS_INGEST_QUEUE_SIZE",
  "SYNTHESIS_INTEGRATE_MAX_TOKENS",
  "SYNTHESIS_INTEGRATE_MODEL",
  "SYNTHESIS_INTEGRATE_TEMPERATURE",
  "SYNTHESIS_LABEL_ZOOM_THRESHOLD",
  "SYNTHESIS_LINK_K",
  "SYNTHESIS_LLM_TEMPERATURE",
  "SYNTHESIS_MAX_BODY_BYTES",
  "SYNTHESIS_MAX_CHARS",
  "SYNTHESIS_MAX_PDF_PAGES",
  "SYNTHESIS_MAX_PASTED_TEXT_CHARS",
  "SYNTHESIS_MAX_PLAYLIST_ITEMS",
  "SYNTHESIS_MAX_TRUSTED_BATCH_ITEMS",
  "SYNTHESIS_MAX_SEARCH_CHARS",
  "SYNTHESIS_MAX_SUBTITLE_BYTES",
  "SYNTHESIS_MAX_TITLE_CHARS",
  "SYNTHESIS_MAX_TOKENS",
  "SYNTHESIS_MAX_TRANSCRIPT_CHARS",
  "SYNTHESIS_MAX_UPLOAD_BYTES",
  "SYNTHESIS_MODEL_TIMEOUT_MS",
  "SYNTHESIS_OPEN_BROWSER",
  "SYNTHESIS_PER_USER_DAILY_JOBS",
  "SYNTHESIS_PDF_PARSE_TIMEOUT_MS",
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
  "SYNTHESIS_WATCH",
  "SYNTHESIS_YT_DLP_PATH",
  "SYNTHESIS_YT_DLP_TIMEOUT_MS",
  "XDG_CONFIG_HOME",
].join(",");

const args = ["run", "--no-prompt", "--unstable-no-legacy-abort"];
if (isDev) args.push("--watch");
args.push(
  "--frozen",
  "--ignore-env=NAPI_RS_FORCE_WASI,NAPI_RS_NATIVE_LIBRARY_PATH",
  "--allow-net",
  "--allow-ffi",
  `--allow-read=web,${vaultDir},${config.appDataDir},${tempDir}${
    os === "linux" ? ",/usr/bin/ldd" : ""
  }`,
  `--allow-write=${vaultDir},${config.appDataDir},${tempDir}`,
  `--allow-run=${ytDlpPath}`,
  `--allow-env=${allowedEnv}`,
  "main.ts",
);

const cmd = new Deno.Command(Deno.execPath(), {
  args,
  env: {
    DISABLE_SYSTEM_FONTS_LOAD: "1",
    SYNTHESIS_YT_DLP_PATH: ytDlpPath,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const process = cmd.spawn();
const stop = () => {
  try {
    process.kill("SIGTERM");
  } catch {
    // The child may already have stopped.
  }
};
Deno.addSignalListener("SIGINT", stop);

let exitCode = 1;
try {
  const url = await announceAndOpen(config.host, port, openBrowser);
  if (trial) printTrialGuide(url);
  exitCode = (await process.status).code;
} finally {
  Deno.removeSignalListener("SIGINT", stop);
  frontendWatcher?.kill();
  await cleanTrialRun(trial);
}
Deno.exit(exitCode);
