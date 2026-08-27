import assert from "node:assert/strict";

import {
  browserExecutableArgument,
  withTimeout,
} from "./browser_interaction_smoke.ts";

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

Deno.test("withTimeout bounds an operation that never settles", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 5, "Operation stalled"),
    /Operation stalled after 5 ms/,
  );
});
