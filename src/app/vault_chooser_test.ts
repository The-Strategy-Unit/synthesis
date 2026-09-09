import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import {
  createVaultChooserHandler,
  directoryPickerCommands,
  isLoopbackHostname,
  pickVaultDirectory,
  validateExistingVaultDirectory,
} from "./vault_chooser.ts";

const VALID_MANIFEST = JSON.stringify({
  formatVersion: 1,
  vaultId: "3f4db942-2253-43ba-8f8f-808fad02f10f",
  createdAt: "2026-09-08T10:30:00.000Z",
});

Deno.test("vault chooser is restricted to loopback hosts", () => {
  for (
    const host of ["127.0.0.1", "127.20.30.40", "localhost", "::1", "[::1]"]
  ) {
    assert.equal(isLoopbackHostname(host), true);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "synthesis.example"]) {
    assert.equal(isLoopbackHostname(host), false);
  }
});

Deno.test("native directory pickers are bounded cross-platform commands", async () => {
  assert.equal(directoryPickerCommands("windows")[0].command, "powershell.exe");
  assert.match(
    directoryPickerCommands("windows")[0].args.at(-1) ?? "",
    /FolderBrowserDialog/,
  );
  assert.deepEqual(directoryPickerCommands("darwin")[0].command, "osascript");
  assert.deepEqual(
    directoryPickerCommands("linux").map(({ command }) => command),
    ["zenity", "kdialog"],
  );

  const calls: string[] = [];
  const selected = await pickVaultDirectory("/unused", "linux", (picker) => {
    calls.push(picker.command);
    return Promise.resolve(
      picker.command === "zenity"
        ? null
        : { code: 0, stdout: new TextEncoder().encode("/vault/path\n") },
    );
  });
  assert.equal(selected, "/vault/path");
  assert.deepEqual(calls, ["zenity", "kdialog"]);
});

Deno.test("selected folders require a valid Synthesis vault manifest", async () => {
  const directory = resolve("existing-vault");
  const manifest = join(directory, "vault.json");
  const access = {
    stat(path: string) {
      if (path === directory) {
        return Promise.resolve({ isDirectory: true, isFile: false, size: 0 });
      }
      if (path === manifest) {
        return Promise.resolve({
          isDirectory: false,
          isFile: true,
          size: VALID_MANIFEST.length,
        });
      }
      return Promise.reject(new Deno.errors.NotFound());
    },
    readTextFile(path: string) {
      assert.equal(path, manifest);
      return Promise.resolve(VALID_MANIFEST);
    },
  };
  assert.equal(
    await validateExistingVaultDirectory("existing-vault", access),
    directory,
  );
  await assert.rejects(
    () => validateExistingVaultDirectory("missing-vault", access),
    /does not exist/,
  );
  await assert.rejects(
    () =>
      validateExistingVaultDirectory("existing-vault", {
        ...access,
        readTextFile: () => Promise.resolve("{}"),
      }),
    /invalid vault\.json/,
  );
  await assert.rejects(
    () =>
      validateExistingVaultDirectory("existing-vault", {
        ...access,
        stat: (path) =>
          Promise.resolve(
            path === directory
              ? { isDirectory: true, isFile: false, size: 0 }
              : { isDirectory: false, isFile: true, size: 1_000_000 },
          ),
      }),
    /invalid vault\.json/,
  );
});

Deno.test("vault chooser validates origin, input, and one final selection", async () => {
  const origin = "http://127.0.0.1:8123";
  const selected: string[] = [];
  const handler = createVaultChooserHandler(
    origin,
    "/default/<vault>",
    (directory) => selected.push(directory),
    () => Promise.resolve(null),
    (value) =>
      value === "/valid/vault"
        ? Promise.resolve("/valid/vault")
        : Promise.reject(new Error("Invalid test vault")),
  );

  const page = await handler(new Request(`${origin}/`));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="choose"/);
  assert.match(html, /Open default vault/);
  assert.match(html, /\/default\/&lt;vault&gt;/);
  assert.match(html, /color-scheme: dark/);
  assert.match(html, /--bg: #12151b/);
  assert.match(html, /--accent-strong: #176fc1/);
  assert.match(
    page.headers.get("Content-Security-Policy") ?? "",
    /script-src 'nonce-/,
  );

  const rejectedOrigin = await handler(
    new Request(`${origin}/api/vault/open`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ path: "/valid/vault" }),
    }),
  );
  assert.equal(rejectedOrigin.status, 403);
  assert.equal((await rejectedOrigin.json()).code, "ORIGIN_NOT_ALLOWED");

  const invalid = await handler(
    new Request(`${origin}/api/vault/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ path: "/invalid/vault" }),
    }),
  );
  assert.equal(invalid.status, 422);
  assert.deepEqual(selected, []);

  const opened = await handler(
    new Request(`${origin}/api/vault/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ path: "/valid/vault" }),
    }),
  );
  assert.equal(opened.status, 200);
  assert.deepEqual(selected, ["/valid/vault"]);

  const duplicate = await handler(
    new Request(`${origin}/api/vault/default`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    }),
  );
  assert.equal(duplicate.status, 409);
});
