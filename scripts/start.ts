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

function assertPortAvailable(hostname: string, port: number): void {
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
}

assertPortAvailable(config.host, port);
await bundleFrontend();
const frontendWatcher = isDev ? frontendBundleCommand(true).spawn() : undefined;

async function waitForServer(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${url}/api/status`, {
        signal: AbortSignal.timeout(250),
      });
      await response.body?.cancel();
      return true;
    } catch {
      // The server normally needs a moment to initialize SQLite and routes.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

interface BrowserCommand {
  command: string;
  args: string[];
}

function browserCommands(url: string): BrowserCommand[] {
  if (Deno.build.os === "windows") {
    return [{ command: "cmd", args: ["/c", "start", url] }];
  }
  if (Deno.build.os === "darwin") {
    return [{ command: "open", args: [url] }];
  }
  return [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
  ];
}

async function tryBrowser(command: BrowserCommand): Promise<boolean> {
  try {
    const status = await new Deno.Command(command.command, {
      args: command.args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().status;
    return status.success;
  } catch {
    return false;
  }
}

async function launchBrowser(url: string): Promise<boolean> {
  for (const command of browserCommands(url)) {
    if (await tryBrowser(command)) return true;
  }
  return false;
}

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
  "SYNTHESIS_MAX_PDF_PAGES",
  "SYNTHESIS_MAX_PASTED_TEXT_CHARS",
  "SYNTHESIS_MAX_PLAYLIST_ITEMS",
  "SYNTHESIS_MAX_SEARCH_CHARS",
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

if (openBrowser) {
  const browserHost = ["0.0.0.0", "::"].includes(config.host)
    ? "localhost"
    : config.host;
  const url = `http://${hostPort(browserHost, port)}`;

  if (!await waitForServer(url)) {
    console.log(`\nServer did not become ready. Open browser to: ${url}\n`);
  } else if (await launchBrowser(url)) {
    console.log(`\nOpened browser: ${url}\n`);
  } else {
    console.log(`\nNo browser was found. Open browser to: ${url}\n`);
  }
}

const status = await process.status;
frontendWatcher?.kill();
Deno.exit(status.code);
