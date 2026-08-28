import assert from "node:assert/strict";

import { parseCompiledOptions } from "../src/app/compiled_entry.ts";
import {
  assertArtifactSize,
  compileArguments,
  compiledDisplayPath,
  compiledFileName,
  parseCompileTarget,
  patchPdfCanvasLoader,
  selectedTargets,
} from "./compile.ts";

Deno.test("cross-platform compilation is explicit, slim, and QuickJS", () => {
  assert.equal(parseCompileTarget([]), "host");
  assert.equal(
    parseCompileTarget(["--target", "windows-x86_64"]),
    "windows-x86_64",
  );
  assert.deepEqual(selectedTargets("all"), [
    "linux-x86_64",
    "macos-aarch64",
    "windows-x86_64",
  ]);
  assert.throws(() => parseCompileTarget(["windows"]), /Usage/);
  assert.equal(compiledFileName("linux-x86_64"), "synthesis-linux-x86_64");
  assert.equal(compiledFileName("macos-aarch64"), "synthesis-macos-aarch64");
  assert.equal(
    compiledFileName("windows-x86_64"),
    "synthesis-windows-x86_64.exe",
  );
  assert.equal(compiledFileName("host", "windows"), "synthesis.exe");
  assert.equal(compiledDisplayPath("synthesis"), "dist/synthesis");
  assert.equal(compiledDisplayPath("synthesis").startsWith("/"), false);

  const args = compileArguments(
    "windows-x86_64",
    "dist/synthesis.exe",
    "dist/.compile-work/src/app/compiled_entry.js",
    ["dist/.compile-work/web/index.html"],
    ["npm:sqlite-vec@0.1.9"],
  );
  assert.deepEqual(args.slice(0, 7), [
    "compile",
    "--frozen",
    "--import-map=deno.json",
    "--engine",
    "quickjs",
    "--self-extracting",
    "--exclude-unused-npm",
  ]);
  assert.ok(args.includes("--allow-ffi"));
  assert.ok(args.includes("--allow-run"));
  assert.ok(!args.includes("--allow-all"));
  assert.ok(args.includes("x86_64-pc-windows-msvc"));
  assert.ok(args.includes("npm:sqlite-vec@0.1.9"));
  assert.ok(args.includes("dist/.compile-work/web/index.html"));
  assert.equal(
    args.at(-1),
    "dist/.compile-work/src/app/compiled_entry.js",
  );
  assert.equal(args.includes("--bundle"), false);

  assert.equal(assertArtifactSize(79 * 1024 * 1024), 79);
  assert.throws(
    () => assertArtifactSize(81 * 1024 * 1024),
    /expected at most 80 MiB/,
  );
});

Deno.test("the pinned PDF.js canvas loader is patched narrowly", () => {
  const source = [
    'canvas = require2("@napi-rs/canvas");',
    'return require2("@napi-rs/canvas").createCanvas(width, height);',
  ].join("\n");
  const patched = patchPdfCanvasLoader(source);
  assert.equal(
    patched.match(/globalThis\.__synthesisPdfCanvas/g)?.length,
    2,
  );
  assert.doesNotMatch(patched, /require2/);
  assert.throws(() => patchPdfCanvasLoader("const untouched = true;"));
});

Deno.test("compiled trial flags are bounded and order-independent", () => {
  assert.deepEqual(parseCompiledOptions([]), {
    trial: false,
    openBrowser: true,
  });
  assert.deepEqual(parseCompiledOptions(["--no-open", "--trial"]), {
    trial: true,
    openBrowser: false,
  });
  assert.throws(() => parseCompiledOptions(["--unknown"]), /Usage/);
  assert.throws(() => parseCompiledOptions(["--trial", "--trial"]), /Usage/);
});
