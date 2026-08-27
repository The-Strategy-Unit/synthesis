import assert from "node:assert/strict";

import { browserCommands, hostPort } from "./browser_launcher.ts";

Deno.test("browser launch commands and loopback URLs are cross-platform", () => {
  assert.equal(hostPort("127.0.0.1", 8000), "127.0.0.1:8000");
  assert.equal(hostPort("::1", 8000), "[::1]:8000");
  assert.deepEqual(browserCommands("http://local", "windows"), [{
    command: "cmd",
    args: ["/c", "start", "http://local"],
  }]);
  assert.deepEqual(browserCommands("http://local", "darwin"), [{
    command: "open",
    args: ["http://local"],
  }]);
  assert.equal(browserCommands("http://local", "linux")[0].command, "xdg-open");
});
