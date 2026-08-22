import assert from "node:assert/strict";

import {
  scopedTestArguments,
  testTempDirectory,
} from "./scoped_test_runner.ts";

Deno.test("test temp paths follow the host platform", () => {
  assert.equal(
    testTempDirectory("windows", {
      TEMP: "D:\\runner\\temp",
      TMP: "D:\\fallback",
    }),
    "D:\\runner\\temp",
  );
  assert.equal(
    testTempDirectory("windows", { TMP: "D:\\fallback" }),
    "D:\\fallback",
  );
  assert.equal(
    testTempDirectory("linux", { TMPDIR: "/private/temp" }),
    "/private/temp",
  );
  assert.equal(testTempDirectory("darwin", {}), "/tmp");
});

Deno.test("scoped test permissions include the resolved temp directory", () => {
  assert.deepEqual(
    scopedTestArguments("e2e", "D:\\runner,temp"),
    [
      "test",
      "--no-prompt",
      "--allow-run",
      "--allow-net=127.0.0.1",
      "--allow-read=.,D:\\runner,,temp",
      "--allow-write=D:\\runner,,temp",
      "scripts/ui_shell_e2e_test.ts",
    ],
  );
  assert.equal(
    scopedTestArguments("compiled", "/tmp", ["dist/synthesis"])
      .at(-1),
    "dist/synthesis",
  );
});
