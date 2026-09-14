import { join, resolve } from "node:path";

import {
  announceAndOpen,
  environmentBoolean,
  hostPort,
  waitForServer,
} from "./browser_launcher.ts";
import { chooseVaultAtStartup, isLoopbackHostname } from "./vault_chooser.ts";

export interface CompiledOptions {
  help: boolean;
  openBrowser: boolean;
  vaultPath: string | null;
}

const COMPILED_USAGE = "Usage: synthesis [--vault <path>] [--no-open] [--help]";

export function compiledHelpText(): string {
  return [
    "Synthesis - local-first knowledge compiler",
    "",
    COMPILED_USAGE,
    "Start without --vault to choose a vault in the browser.",
    "",
    "Options:",
    "  --vault    Start with the vault at the supplied path.",
    "  --no-open  Start without opening a browser.",
    "  --help     Show this help and exit.",
  ].join("\n");
}

export function parseCompiledOptions(args: readonly string[]): CompiledOptions {
  let help = false;
  let openBrowser = true;
  let vaultPath: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help") {
      if (help) throw new Error(COMPILED_USAGE);
      help = true;
      continue;
    }
    if (argument === "--no-open") {
      if (!openBrowser) throw new Error(COMPILED_USAGE);
      openBrowser = false;
      continue;
    }
    if (argument === "--vault") {
      const value = args[++index];
      if (
        vaultPath !== null || !value || value.startsWith("--") ||
        value.length > 4_096 || /\p{Cc}/u.test(value)
      ) {
        throw new Error(COMPILED_USAGE);
      }
      vaultPath = value;
      continue;
    }
    throw new Error(COMPILED_USAGE);
  }
  return { help, openBrowser, vaultPath };
}

async function main(): Promise<void> {
  const options = parseCompiledOptions(Deno.args);
  if (options.help) {
    console.log(compiledHelpText());
    return;
  }
  // The compiled app uses PDF.js only for server-side text extraction. Its
  // Node build still loads a rendering canvas, so the narrow compile-time
  // patch points that loader at this deliberately non-rendering facade.
  class TextExtractionPath2D {}
  const runtimeGlobals = globalThis as typeof globalThis & {
    Path2D?: unknown;
  };
  const pdfCanvas = {
    DOMMatrix: globalThis.DOMMatrix,
    Path2D: TextExtractionPath2D,
    createCanvas(): never {
      throw new Error("PDF rendering is unavailable in the text-only runtime");
    },
  };
  Object.assign(globalThis, {
    __synthesisPdfCanvas: pdfCanvas,
    Path2D: runtimeGlobals.Path2D ?? pdfCanvas.Path2D,
  });
  const configuredVaultPath = Deno.env.get("SYNTHESIS_VAULT")?.trim();
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  try {
    if (options.vaultPath !== null) {
      const vaultPath = resolve(options.vaultPath);
      const manifest = await Deno.stat(join(vaultPath, "vault.json")).catch(
        () => null,
      );
      if (!manifest?.isFile) {
        throw new Error(
          `Vault ${vaultPath} does not contain a regular vault.json file`,
        );
      }
      Deno.env.set("SYNTHESIS_VAULT", vaultPath);
    }
    const { config } = await import("./config.ts");
    const openBrowser = options.openBrowser &&
      environmentBoolean("SYNTHESIS_OPEN_BROWSER", true);
    const vaultSwitchEnabled = options.vaultPath === null &&
      !configuredVaultPath &&
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
        port: config.port,
        signal: controller.signal,
      });
      Deno.env.set("SYNTHESIS_VAULT", config.vaultDir);
      selectedWithChooser = true;
    }
    const { startApplication } = await import("./application.ts");
    const url = `http://${hostPort(config.host, config.port)}`;
    let firstApplication = true;
    let previousVaultDirectory = config.vaultDir;
    while (!controller.signal.aborted) {
      let requestSwitch!: () => void;
      const switchRequested = new Promise<void>((resolve) => {
        requestSwitch = resolve;
      });
      let session: Awaited<ReturnType<typeof startApplication>>;
      try {
        session = await startApplication(controller.signal, {
          onVaultSwitch: vaultSwitchEnabled ? requestSwitch : undefined,
        });
      } catch (error) {
        if (!vaultSwitchEnabled || !selectedWithChooser) throw error;
        console.error("The selected vault could not be opened safely.");
        config.vaultDir = await chooseVaultAtStartup({
          announceAndOpen,
          defaultActionLabel: "Reopen previous vault",
          defaultDirectory: previousVaultDirectory,
          hostname: config.host,
          message:
            "That vault could not be opened. Choose another vault or reopen the previous one.",
          openBrowser: false,
          port: config.port,
          signal: controller.signal,
        });
        Deno.env.set("SYNTHESIS_VAULT", config.vaultDir);
        selectedWithChooser = true;
        continue;
      }

      if (selectedWithChooser) {
        if (await waitForServer(url)) console.log(`\nOpened vault: ${url}\n`);
        else {
          console.log(
            `\nVault did not become ready. Reload browser: ${url}\n`,
          );
        }
      } else if (firstApplication) {
        await announceAndOpen(config.host, config.port, openBrowser);
      }
      firstApplication = false;
      selectedWithChooser = false;

      const outcome = await Promise.race([
        session.finished.then(() => "finished" as const),
        switchRequested.then(() => "switch" as const),
      ]);
      if (outcome === "finished") break;

      await session.close();
      if (controller.signal.aborted) break;
      previousVaultDirectory = config.vaultDir;
      config.vaultDir = await chooseVaultAtStartup({
        announceAndOpen,
        defaultActionLabel: "Reopen previous vault",
        defaultDirectory: previousVaultDirectory,
        hostname: config.host,
        message: "Current vault closed safely. Choose another vault.",
        openBrowser: false,
        port: config.port,
        signal: controller.signal,
      });
      Deno.env.set("SYNTHESIS_VAULT", config.vaultDir);
      selectedWithChooser = true;
    }
  } catch (error) {
    if (!(controller.signal.aborted && error instanceof DOMException)) {
      throw error;
    }
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
  }
  Deno.exit(0);
}

if (import.meta.main) await main();
