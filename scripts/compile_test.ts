import assert from "node:assert/strict";

import {
  compileArguments,
  compiledDisplayPath,
  compiledFileName,
  parseCompileTarget,
} from "./compile.ts";

Deno.test("Windows compilation is explicit, native-compatible, and QuickJS", () => {
  assert.equal(parseCompileTarget([]), "host");
  assert.equal(parseCompileTarget(["--target", "windows"]), "windows");
  assert.throws(() => parseCompileTarget(["windows"]), /Usage/);
  assert.equal(
    compiledFileName("windows", "linux"),
    "synthesis-windows-x86_64.exe",
  );
  assert.equal(compiledFileName("host", "windows"), "synthesis.exe");
  assert.equal(compiledDisplayPath("synthesis"), "dist/synthesis");
  assert.equal(compiledDisplayPath("synthesis").startsWith("/"), false);

  const args = compileArguments("windows", "dist/synthesis.exe");
  assert.deepEqual(args.slice(0, 6), [
    "compile",
    "--frozen",
    "--engine",
    "quickjs",
    "--self-extracting",
    "--include",
  ]);
  assert.ok(args.includes("--allow-all"));
  assert.ok(args.includes("x86_64-pc-windows-msvc"));
  assert.equal(args.includes("--bundle"), false);
});
