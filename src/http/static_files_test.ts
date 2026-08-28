import assert from "node:assert/strict";

import { isPathWithin } from "./static_files.ts";

Deno.test("static asset containment is separator- and prefix-safe", () => {
  assert.equal(
    isPathWithin("/app/web", "/app/web/index.html", "posix"),
    true,
  );
  assert.equal(
    isPathWithin("/app/web", "/app/web-evil/index.html", "posix"),
    false,
  );
  assert.equal(
    isPathWithin(
      String.raw`C:\app\web`,
      String.raw`C:\app\web\index.html`,
      "windows",
    ),
    true,
  );
  assert.equal(
    isPathWithin(
      String.raw`C:\app\web`,
      String.raw`C:\app\web-evil\index.html`,
      "windows",
    ),
    false,
  );
  assert.equal(
    isPathWithin(
      String.raw`C:\app\web`,
      String.raw`D:\app\web\index.html`,
      "windows",
    ),
    false,
  );
});
