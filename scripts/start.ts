#!/usr/bin/env deno run --allow-all
/**
 * Cross-platform start script for Synthesis
 * Set SYNTHESIS_WATCH=true for development mode with auto-reload
 */

import {
  announceAndOpen,
  environmentBoolean,
  hostPort,
  waitForServer,
} from "../src/app/browser_launcher.ts";
import {
  chooseVaultAtStartup,
  isLoopbackHostname,
} from "../src/app/vault_chooser.ts";
import {
  SUPERVISED_VAULT_SWITCH_ARGUMENT,
  VAULT_SWITCH_EXIT_CODE,
} from "../src/app/process_protocol.ts";

if (Deno.args.length > 0) throw new Error("Usage: scripts/start.ts");
const { config } = await import("../src/app/config.ts");
const port = config.port;
const isDev = Deno.env.get("SYNTHESIS_WATCH") === "true";
const openBrowser = environmentBoolean("SYNTHESIS_OPEN_BROWSER", true);

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

const permissionPath = (path: string): string => path.replaceAll(",", ",,");

assertPortAvailable(config.host, port);
const configuredVaultDirectory = Deno.env.get("SYNTHESIS_VAULT")?.trim();
const vaultSwitchEnabled = !configuredVaultDirectory &&
  isLoopbackHostname(config.host) &&
  config.security.publicOrigin === undefined &&
  !config.security.trustProxyAuth;
let selectedWithChooser = false;
if (vaultSwitchEnabled) {
  config.vaultDir = await chooseVaultAtStartup({
    announceAndOpen,
    defaultDirectory: config.vaultDir,
    hostname: config.host,
    openBrowser,
    port,
  });
  Deno.env.set("SYNTHESIS_VAULT", config.vaultDir);
  selectedWithChooser = true;
}
let vaultDirectory = config.vaultDir;
await bundleFrontend();
const frontendWatcher = isDev ? frontendBundleCommand(true).spawn() : undefined;

const allowedEnv = [
  "CI",
  "DISABLE_SYSTEM_FONTS_LOAD",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
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
  "SYNTHESIS_WATCH",
  "SYNTHESIS_YT_DLP_PATH",
  "XDG_CONFIG_HOME",
].join(",");

function applicationCommand(directory: string): Deno.Command {
  const args = ["run", "--no-prompt", "--unstable-no-legacy-abort"];
  if (isDev) args.push("--watch");
  args.push(
    "--frozen",
    "--ignore-env=NAPI_RS_FORCE_WASI,NAPI_RS_NATIVE_LIBRARY_PATH",
    "--allow-net",
    "--allow-ffi",
    `--allow-read=web,${permissionPath(directory)},${
      permissionPath(config.appDataDir)
    },${permissionPath(tempDir)}${os === "linux" ? ",/usr/bin/ldd" : ""}`,
    `--allow-write=${permissionPath(directory)},${
      permissionPath(config.appDataDir)
    },${permissionPath(tempDir)}`,
    `--allow-run=${ytDlpPath}`,
    `--allow-env=${allowedEnv}`,
    "main.ts",
    ...(vaultSwitchEnabled ? [SUPERVISED_VAULT_SWITCH_ARGUMENT] : []),
  );
  return new Deno.Command(Deno.execPath(), {
    args,
    env: {
      DISABLE_SYSTEM_FONTS_LOAD: "1",
      SYNTHESIS_YT_DLP_PATH: ytDlpPath,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

let process: Deno.ChildProcess | undefined;
let stopping = false;
const chooserController = new AbortController();
const stop = () => {
  stopping = true;
  chooserController.abort();
  try {
    process?.kill("SIGTERM");
  } catch {
    // The child may already have stopped.
  }
};
Deno.addSignalListener("SIGINT", stop);

let exitCode = 1;
try {
  const url = `http://${hostPort(config.host, port)}`;
  let firstApplication = true;
  let previousVaultDirectory = vaultDirectory;
  while (!stopping) {
    process = applicationCommand(vaultDirectory).spawn();
    const processStatus = process.status;
    if (selectedWithChooser) {
      if (await waitForServer(url)) {
        console.log(`\nOpened vault: ${url}\n`);
      } else {
        try {
          process.kill("SIGTERM");
        } catch {
          // The failed child may already have exited.
        }
        const status = await processStatus;
        process = undefined;
        if (
          status.code === VAULT_SWITCH_EXIT_CODE && vaultSwitchEnabled &&
          !stopping
        ) {
          previousVaultDirectory = vaultDirectory;
          vaultDirectory = await chooseVaultAtStartup({
            announceAndOpen,
            defaultActionLabel: "Reopen previous vault",
            defaultDirectory: previousVaultDirectory,
            hostname: config.host,
            message: "Current vault closed safely. Choose another vault.",
            openBrowser: false,
            port,
            signal: chooserController.signal,
          });
          config.vaultDir = vaultDirectory;
          Deno.env.set("SYNTHESIS_VAULT", vaultDirectory);
          selectedWithChooser = true;
          continue;
        }
        if (!vaultSwitchEnabled || stopping) {
          exitCode = status.code;
          break;
        }
        vaultDirectory = await chooseVaultAtStartup({
          announceAndOpen,
          defaultActionLabel: "Reopen previous vault",
          defaultDirectory: previousVaultDirectory,
          hostname: config.host,
          message:
            "That vault could not be opened. Choose another vault or reopen the previous one.",
          openBrowser: false,
          port,
          signal: chooserController.signal,
        });
        config.vaultDir = vaultDirectory;
        Deno.env.set("SYNTHESIS_VAULT", vaultDirectory);
        selectedWithChooser = true;
        continue;
      }
    } else if (firstApplication) {
      await announceAndOpen(config.host, port, openBrowser);
    }
    firstApplication = false;
    selectedWithChooser = false;

    const status = await processStatus;
    process = undefined;
    if (
      status.code !== VAULT_SWITCH_EXIT_CODE || !vaultSwitchEnabled || stopping
    ) {
      exitCode = status.code;
      break;
    }

    previousVaultDirectory = vaultDirectory;
    vaultDirectory = await chooseVaultAtStartup({
      announceAndOpen,
      defaultActionLabel: "Reopen previous vault",
      defaultDirectory: previousVaultDirectory,
      hostname: config.host,
      message: "Current vault closed safely. Choose another vault.",
      openBrowser: false,
      port,
      signal: chooserController.signal,
    });
    config.vaultDir = vaultDirectory;
    Deno.env.set("SYNTHESIS_VAULT", vaultDirectory);
    selectedWithChooser = true;
  }
} catch (error) {
  if (!(stopping && error instanceof DOMException)) throw error;
  exitCode = 0;
} finally {
  Deno.removeSignalListener("SIGINT", stop);
  frontendWatcher?.kill();
}
Deno.exit(exitCode);
