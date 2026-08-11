import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type CompileTarget = "host" | "windows";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIRECTORY = join(PROJECT_DIRECTORY, "dist");

export function parseCompileTarget(args: string[]): CompileTarget {
  if (args.length === 0) return "host";
  if (args.length === 2 && args[0] === "--target") {
    if (args[1] === "host" || args[1] === "windows") return args[1];
  }
  throw new Error("Usage: scripts/compile.ts [--target host|windows]");
}

export function compiledFileName(
  target: CompileTarget,
  hostOs: typeof Deno.build.os = Deno.build.os,
): string {
  if (target === "windows") return "synthesis-windows-x86_64.exe";
  return hostOs === "windows" ? "synthesis.exe" : "synthesis";
}

export function compileArguments(
  target: CompileTarget,
  output: string,
): string[] {
  return [
    "compile",
    "--frozen",
    "--engine",
    "quickjs",
    "--self-extracting",
    "--include",
    "web",
    "--allow-all",
    "--app-name",
    "Synthesis",
    ...(target === "windows" ? ["--target", "x86_64-pc-windows-msvc"] : []),
    "--output",
    output,
    "main.ts",
  ];
}

async function runDeno(args: string[]): Promise<void> {
  const status = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: PROJECT_DIRECTORY,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`deno ${args[0]} failed with exit code ${status.code}`);
  }
}

async function main(): Promise<void> {
  const target = parseCompileTarget(Deno.args);
  await Deno.mkdir(DIST_DIRECTORY, { recursive: true });
  await runDeno([
    "bundle",
    "--platform",
    "browser",
    "--output",
    "web/app.bundle.js",
    "web/app.js",
  ]);
  const output = join(DIST_DIRECTORY, compiledFileName(target));
  await runDeno(compileArguments(target, output));
  const sizeMiB = (await Deno.stat(output)).size / 1024 / 1024;
  console.log(`Created ${output} (${sizeMiB.toFixed(1)} MiB)`);
}

if (import.meta.main) await main();
