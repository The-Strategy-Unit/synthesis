import assert from "node:assert/strict";

import { browserExecutableArgument } from "./browser_interaction_smoke.ts";

Deno.test("browserExecutableArgument accepts a direct task argument", () => {
  assert.equal(
    browserExecutableArgument(["/usr/bin/chromium"]),
    "/usr/bin/chromium",
  );
});

Deno.test("browserExecutableArgument accepts a task argument after --", () => {
  assert.equal(
    browserExecutableArgument(["--", "/usr/bin/chromium"]),
    "/usr/bin/chromium",
  );
});

Deno.test("browserExecutableArgument ignores an empty separator", () => {
  assert.equal(browserExecutableArgument(["--"]), undefined);
});
