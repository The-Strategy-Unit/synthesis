import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type CompileTarget =
  | "host"
  | "linux-x86_64"
  | "macos-aarch64"
  | "windows-x86_64";
export type CompileSelection = CompileTarget | "all";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIRECTORY = join(PROJECT_DIRECTORY, "dist");
const WORK_DIRECTORY = join(DIST_DIRECTORY, ".compile-work");
const ENTRY_DIRECTORY = join(WORK_DIRECTORY, "src", "app");
const UNPATCHED_ENTRY = join(
  ENTRY_DIRECTORY,
  "compiled_entry.unpatched.js",
);
const BUNDLED_ENTRY = join(ENTRY_DIRECTORY, "compiled_entry.js");
const PDF_WORKER = join(ENTRY_DIRECTORY, "pdf.worker.mjs");
const WEB_DIRECTORY = join(WORK_DIRECTORY, "web");
const MAX_ARTIFACT_MIB = 80;
const PACKAGE_ALIASES = ["keyring", "sqlite-vec"] as const;
const PDF_WORKER_PACKAGE = "npm:pdfjs-dist@6.2.108/legacy/build/pdf.worker.mjs";

const TARGET_TRIPLES: Record<Exclude<CompileTarget, "host">, string> = {
  "linux-x86_64": "x86_64-unknown-linux-gnu",
  "macos-aarch64": "aarch64-apple-darwin",
  "windows-x86_64": "x86_64-pc-windows-msvc",
};

const RELEASE_TARGETS: CompileTarget[] = [
  "linux-x86_64",
  "macos-aarch64",
  "windows-x86_64",
];

export function parseCompileTarget(args: string[]): CompileSelection {
  if (args.length === 0) return "host";
  if (args.length === 2 && args[0] === "--target") {
    if (
      args[1] === "host" || args[1] === "all" ||
      args[1] === "linux-x86_64" || args[1] === "macos-aarch64" ||
      args[1] === "windows-x86_64"
    ) {
      return args[1];
    }
  }
  throw new Error(
    "Usage: scripts/compile.ts [--target host|all|linux-x86_64|macos-aarch64|windows-x86_64]",
  );
}

export function selectedTargets(selection: CompileSelection): CompileTarget[] {
  return selection === "all" ? [...RELEASE_TARGETS] : [selection];
}

export function compiledFileName(
  target: CompileTarget,
  hostOs: typeof Deno.build.os = Deno.build.os,
): string {
  if (target === "linux-x86_64") return "synthesis-linux-x86_64";
  if (target === "macos-aarch64") return "synthesis-macos-aarch64";
  if (target === "windows-x86_64") return "synthesis-windows-x86_64.exe";
  return hostOs === "windows" ? "synthesis.exe" : "synthesis";
}

export function compiledDisplayPath(fileName: string): string {
  return `dist/${fileName}`;
}

export function compileArguments(
  target: CompileTarget,
  output: string,
  entry: string,
  webAssets: readonly string[],
  nativePackages: readonly string[],
): string[] {
  const targetTriple = target === "host" ? undefined : TARGET_TRIPLES[target];
  return [
    "compile",
    "--frozen",
    "--import-map=deno.json",
    "--engine",
    "quickjs",
    "--self-extracting",
    "--exclude-unused-npm",
    ...nativePackages.flatMap((specifier) => ["--include", specifier]),
    ...webAssets.flatMap((asset) => ["--include", asset]),
    "--no-prompt",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-ffi",
    "--app-name",
    "Synthesis",
    ...(targetTriple ? ["--target", targetTriple] : []),
    "--output",
    output,
    entry,
  ];
}

export function assertArtifactSize(
  bytes: number,
  maximumMiB = MAX_ARTIFACT_MIB,
): number {
  const sizeMiB = bytes / 1024 / 1024;
  if (sizeMiB > maximumMiB) {
    throw new Error(
      `Compiled artefact is ${
        sizeMiB.toFixed(1)
      } MiB; expected at most ${maximumMiB} MiB`,
    );
  }
  return sizeMiB;
}

export function patchPdfCanvasLoader(source: string): string {
  const dynamicCanvasRequire = /\b[$A-Z_a-z][$\w]*\("@napi-rs\/canvas"\)/g;
  const matches = source.match(dynamicCanvasRequire) ?? [];
  if (matches.length !== 2) {
    throw new Error(
      `Expected two PDF.js canvas loaders, found ${matches.length}`,
    );
  }
  return source.replaceAll(
    dynamicCanvasRequire,
    "globalThis.__synthesisPdfCanvas",
  );
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

async function nativePackageSpecifiers(): Promise<string[]> {
  const denoConfig = JSON.parse(
    await Deno.readTextFile(join(PROJECT_DIRECTORY, "deno.json")),
  ) as { imports?: Record<string, unknown> };
  const configuredPackages = PACKAGE_ALIASES.map((alias) => {
    const value = denoConfig.imports?.[alias];
    if (typeof value !== "string" || !value.startsWith("npm:")) {
      throw new Error(`deno.json import ${alias} must be an npm specifier`);
    }
    return value;
  });
  return configuredPackages;
}

async function prepareCompileWorkspace(): Promise<string[]> {
  await Deno.remove(WORK_DIRECTORY, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  // Preserve the source entrypoint's depth so bundled import.meta paths still
  // resolve ../../web to the embedded asset directory.
  await Deno.mkdir(ENTRY_DIRECTORY, { recursive: true });
  await Deno.mkdir(WEB_DIRECTORY, { recursive: true });

  const frontendBundle = join(WEB_DIRECTORY, "app.bundle.js");
  await runDeno([
    "bundle",
    "--frozen",
    "--platform",
    "browser",
    "--output",
    relative(PROJECT_DIRECTORY, frontendBundle),
    "web/app.js",
  ]);
  const webAssets = ["index.html", "style.css"].map((fileName) =>
    join(WEB_DIRECTORY, fileName)
  );
  for (const asset of webAssets) {
    await Deno.copyFile(
      join(PROJECT_DIRECTORY, "web", basename(asset)),
      asset,
    );
  }
  webAssets.push(frontendBundle);

  await runDeno([
    "bundle",
    "--frozen",
    "--platform",
    "deno",
    "--external",
    "keyring",
    "--external",
    "sqlite-vec",
    "--output",
    relative(PROJECT_DIRECTORY, UNPATCHED_ENTRY),
    "src/app/compiled_entry.ts",
  ]);
  const patchedEntry = patchPdfCanvasLoader(
    await Deno.readTextFile(UNPATCHED_ENTRY),
  );
  await Deno.writeTextFile(UNPATCHED_ENTRY, patchedEntry);
  await runDeno([
    "bundle",
    "--frozen",
    "--platform",
    "deno",
    "--minify",
    "--external",
    "keyring",
    "--external",
    "sqlite-vec",
    "--output",
    relative(PROJECT_DIRECTORY, BUNDLED_ENTRY),
    relative(PROJECT_DIRECTORY, UNPATCHED_ENTRY),
  ]);
  await runDeno([
    "bundle",
    "--frozen",
    "--platform",
    "deno",
    "--minify",
    "--output",
    relative(PROJECT_DIRECTORY, PDF_WORKER),
    PDF_WORKER_PACKAGE,
  ]);
  return [...webAssets, PDF_WORKER].map((asset) =>
    relative(PROJECT_DIRECTORY, asset)
  );
}

async function main(): Promise<void> {
  const selection = parseCompileTarget(Deno.args);
  await Deno.mkdir(DIST_DIRECTORY, { recursive: true });
  try {
    const webAssets = await prepareCompileWorkspace();
    const nativePackages = await nativePackageSpecifiers();
    for (const target of selectedTargets(selection)) {
      const fileName = compiledFileName(target);
      const output = join(DIST_DIRECTORY, fileName);
      await runDeno(compileArguments(
        target,
        output,
        relative(PROJECT_DIRECTORY, BUNDLED_ENTRY),
        webAssets,
        nativePackages,
      ));
      const sizeMiB = assertArtifactSize((await Deno.stat(output)).size);
      console.log(
        `Created ${compiledDisplayPath(fileName)} (${sizeMiB.toFixed(1)} MiB)`,
      );
    }
  } finally {
    await Deno.remove(WORK_DIRECTORY, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) await main();
