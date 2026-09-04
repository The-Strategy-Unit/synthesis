import { join, resolve } from "node:path";

import { announceAndOpen, environmentBoolean } from "./browser_launcher.ts";
import {
  cleanTrialRun,
  type PreparedTrialRun,
  prepareTrialRun,
  printTrialGuide,
} from "./trial_vault.ts";

export interface CompiledOptions {
  trial: boolean;
  openBrowser: boolean;
  vaultPath: string | null;
}

export function parseCompiledOptions(args: readonly string[]): CompiledOptions {
  const usage = "Usage: synthesis [--trial | --vault <path>] [--no-open]";
  let trial = false;
  let openBrowser = true;
  let vaultPath: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--trial") {
      if (trial) throw new Error(usage);
      trial = true;
      continue;
    }
    if (argument === "--no-open") {
      if (!openBrowser) throw new Error(usage);
      openBrowser = false;
      continue;
    }
    if (argument === "--vault") {
      const value = args[++index];
      if (
        vaultPath !== null || !value || value.startsWith("--") ||
        value.length > 4_096 || /\p{Cc}/u.test(value)
      ) {
        throw new Error(usage);
      }
      vaultPath = value;
      continue;
    }
    throw new Error(usage);
  }
  if (trial && vaultPath !== null) throw new Error(usage);
  return { trial, openBrowser, vaultPath };
}

async function main(): Promise<void> {
  const options = parseCompiledOptions(Deno.args);
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
  let trial: PreparedTrialRun | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  try {
    if (options.trial) {
      trial = await prepareTrialRun();
    } else if (options.vaultPath !== null) {
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
    const [{ config }, { startApplication }] = await Promise.all([
      import("./config.ts"),
      import("./application.ts"),
    ]);
    const server = await startApplication(controller.signal);
    const openBrowser = options.openBrowser &&
      environmentBoolean("SYNTHESIS_OPEN_BROWSER", true);
    const url = await announceAndOpen(config.host, config.port, openBrowser);
    if (trial) printTrialGuide(url);
    await server.finished;
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
    await cleanTrialRun(trial);
  }
  Deno.exit(0);
}

if (import.meta.main) await main();
