import { announceAndOpen, environmentBoolean } from "./browser_launcher.ts";
import {
  cleanTrialRun,
  type PreparedTrialRun,
  prepareTrialRun,
  printTrialGuide,
} from "./trial_vault.ts";

export interface CompiledOptions {
  help: boolean;
  trial: boolean;
  openBrowser: boolean;
}

const COMPILED_USAGE = "Usage: synthesis [--trial] [--no-open] [--help]";

export function compiledHelpText(): string {
  return [
    "Synthesis - local-first knowledge compiler",
    "",
    COMPILED_USAGE,
    "",
    "Options:",
    "  --trial    Start with a disposable, provider-free demonstration vault.",
    "  --no-open  Start without opening a browser.",
    "  --help     Show this help and exit.",
  ].join("\n");
}

export function parseCompiledOptions(args: readonly string[]): CompiledOptions {
  const allowed = new Set(["--trial", "--no-open", "--help"]);
  if (
    args.some((argument) => !allowed.has(argument)) ||
    new Set(args).size !== args.length
  ) {
    throw new Error(COMPILED_USAGE);
  }
  return {
    help: args.includes("--help"),
    trial: args.includes("--trial"),
    openBrowser: !args.includes("--no-open"),
  };
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
  let trial: PreparedTrialRun | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows"
    ? ["SIGINT"]
    : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);
  try {
    if (options.trial) trial = await prepareTrialRun();
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
