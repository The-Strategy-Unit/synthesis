import { join, resolve } from "node:path";

import { hostPort } from "./browser_launcher.ts";
import { validateVaultManifest } from "../vault/vault_manifest_format.ts";

const MAX_VAULT_PATH_CHARS = 4_096;
const MAX_REQUEST_BYTES = 8_192;
const MAX_MANIFEST_BYTES = 16_384;

export interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

interface VaultFileAccess {
  stat(
    path: string,
  ): Promise<Pick<Deno.FileInfo, "isDirectory" | "isFile" | "size">>;
  readTextFile(path: string): Promise<string>;
}

interface PickerCommandResult {
  code: number;
  stdout: Uint8Array;
}

export interface VaultChooserOptions {
  defaultDirectory: string;
  hostname: string;
  port: number;
  openBrowser: boolean;
  signal?: AbortSignal;
  announceAndOpen(
    hostname: string,
    port: number,
    openBrowser: boolean,
  ): Promise<string>;
  pickDirectory?: (defaultDirectory: string) => Promise<string | null>;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalised = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalised === "localhost" || normalised === "::1") return true;
  const octets = normalised.split(".");
  return octets.length === 4 && octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function directoryPickerCommands(
  os: typeof Deno.build.os = Deno.build.os,
): DirectoryPickerCommand[] {
  if (os === "windows") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Open a Synthesis vault'",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
    ].join("; ");
    return [{
      command: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", script],
    }];
  }
  if (os === "darwin") {
    return [{
      command: "osascript",
      args: [
        "-e",
        'POSIX path of (choose folder with prompt "Open a Synthesis vault")',
      ],
    }];
  }
  return [
    {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=Open a Synthesis vault",
      ],
    },
    {
      command: "kdialog",
      args: [
        "--getexistingdirectory",
        ".",
        "--title",
        "Open a Synthesis vault",
      ],
    },
  ];
}

async function runPickerCommand(
  picker: DirectoryPickerCommand,
): Promise<PickerCommandResult | null> {
  try {
    const output = await new Deno.Command(picker.command, {
      args: picker.args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return { code: output.code, stdout: output.stdout };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function pickVaultDirectory(
  _defaultDirectory: string,
  os: typeof Deno.build.os = Deno.build.os,
  run: (
    picker: DirectoryPickerCommand,
  ) => Promise<PickerCommandResult | null> = runPickerCommand,
): Promise<string | null> {
  for (const picker of directoryPickerCommands(os)) {
    const result = await run(picker);
    if (result === null) continue;
    if (result.code !== 0) return null;
    const path = new TextDecoder().decode(result.stdout).trim();
    return path || null;
  }
  return null;
}

export async function validateExistingVaultDirectory(
  value: unknown,
  access: VaultFileAccess = {
    stat: (path) => Deno.stat(path),
    readTextFile: (path) => Deno.readTextFile(path),
  },
): Promise<string> {
  if (
    typeof value !== "string" || value.trim() === "" ||
    value.length > MAX_VAULT_PATH_CHARS || /\p{Cc}/u.test(value)
  ) {
    throw new Error("Choose a valid vault folder");
  }
  const directory = resolve(value.trim());
  const directoryInfo = await access.stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory) {
    throw new Error("The selected vault folder does not exist");
  }
  const manifestPath = join(directory, "vault.json");
  const manifestInfo = await access.stat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile) {
    throw new Error("The selected folder does not contain vault.json");
  }
  if (manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw new Error("The selected folder contains an invalid vault.json");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await access.readTextFile(manifestPath));
    validateVaultManifest(manifest);
  } catch {
    throw new Error("The selected folder contains an invalid vault.json");
  }
  return directory;
}

function chooserOrigin(hostname: string, port: number): string {
  return `http://${hostPort(hostname, port)}`;
}

function securityHeaders(nonce?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": nonce
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
      : "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  return headers;
}

function json(value: unknown, status = 200): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(value, { status, headers });
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function chooserHtml(defaultDirectory: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open a vault · Synthesis</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      font-family: system-ui, -apple-system, sans-serif;
      --bg: #12151b;
      --bg-elevated: #191d25;
      --panel: #1f242e;
      --panel-2: #292f3b;
      --border: #3a4250;
      --text: #ffffff;
      --text-muted: #c8cdd9;
      --text-faint: #9da5b5;
      --accent: #4a9eff;
      --accent-strong: #176fc1;
      --accent-action-hover: #0f5f9f;
      --accent-soft: #7bb8ff;
      --error: #ff6b6b;
      --shadow: rgba(0, 0, 0, 0.5);
      color: var(--text);
      background: var(--bg);
    }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: var(--text); background: var(--bg); }
    main { width: min(100%, 620px); padding: clamp(28px, 6vw, 52px); border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated); box-shadow: 0 20px 60px var(--shadow); }
    .eyebrow { margin: 0 0 8px; color: var(--accent-soft); font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 3.25rem); letter-spacing: -.045em; }
    .intro { max-width: 48ch; margin: 14px 0 28px; color: var(--text-muted); line-height: 1.55; }
    button, input { width: 100%; min-height: 46px; border-radius: 7px; font: inherit; }
    button { border: 1px solid var(--accent-strong); padding: 10px 16px; color: var(--text); background: var(--accent-strong); font-weight: 650; cursor: pointer; }
    button:hover { background: var(--accent-action-hover); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: .65; }
    .secondary { margin-top: 10px; border-color: var(--border); color: var(--text); background: var(--panel); }
    .secondary:hover { border-color: var(--text-faint); background: var(--panel-2); }
    .default-path { display: block; overflow: hidden; margin-top: 5px; color: var(--text-faint); font-family: ui-monospace, monospace; font-size: .78rem; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
    details { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 18px; }
    summary { cursor: pointer; color: var(--text-muted); font-weight: 650; }
    form { margin-top: 15px; }
    label { display: block; margin-bottom: 7px; font-size: .9rem; font-weight: 650; }
    input { border: 1px solid var(--border); padding: 9px 11px; color: var(--text); background: var(--panel); }
    form button { margin-top: 10px; }
    #status { min-height: 1.5em; margin: 18px 0 0; color: var(--error); line-height: 1.45; }
    #status.busy { color: var(--accent-soft); }
    @media (max-width: 520px) { body { padding: 0; } main { min-height: 100vh; border: 0; border-radius: 0; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Synthesis</p>
    <h1>Open a vault</h1>
    <p class="intro">Choose an existing Synthesis vault, or continue with your default local vault. One vault stays open until Synthesis stops.</p>
    <button id="choose" type="button">Choose vault folder</button>
    <button id="default" class="secondary" type="button">
      Open default vault
      <span class="default-path" title="${htmlEscape(defaultDirectory)}">${
    htmlEscape(defaultDirectory)
  }</span>
    </button>
    <details>
      <summary>Enter a folder path instead</summary>
      <form id="path-form">
        <label for="path">Vault folder</label>
        <input id="path" name="path" type="text" autocomplete="off" spellcheck="false" required>
        <button type="submit">Open this vault</button>
      </form>
    </details>
    <p id="status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false"></p>
  </main>
  <script nonce="${nonce}">
    const status = document.getElementById("status");
    const controls = [...document.querySelectorAll("button, input")];
    const pathDetails = document.querySelector("details");
    const pathInput = document.getElementById("path");
    const setBusy = (message) => {
      status.textContent = message;
      status.classList.add("busy");
      status.setAttribute("aria-busy", "true");
      for (const control of controls) control.disabled = true;
    };
    const setError = (message) => {
      status.textContent = message;
      status.classList.remove("busy");
      status.setAttribute("aria-busy", "false");
      for (const control of controls) control.disabled = false;
    };
    const post = async (path, body = {}) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Synthesis could not open that vault");
      return result;
    };
    const awaitApplication = async () => {
      setBusy("Opening vault…");
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          const response = await fetch("/api/status", { cache: "no-store" });
          const result = await response.json();
          if (result.status === "ok") {
            location.replace("/");
            return;
          }
        } catch { /* The chooser and application briefly exchange the port. */ }
      }
      setError("This vault did not start. Stop and reopen Synthesis, then choose another vault.");
    };
    document.getElementById("choose").addEventListener("click", async () => {
      setBusy("Waiting for a folder…");
      try {
        const result = await post("/api/vault/browse");
        if (result.cancelled) {
          pathDetails.open = true;
          setError("No folder was selected. You can try again or enter its path below.");
          pathInput.focus();
          return;
        }
        await awaitApplication();
      } catch (error) {
        setError(error instanceof Error ? error.message : "Synthesis could not open that vault");
      }
    });
    document.getElementById("default").addEventListener("click", async () => {
      setBusy("Opening default vault…");
      try {
        await post("/api/vault/default");
        await awaitApplication();
      } catch (error) {
        setError(error instanceof Error ? error.message : "Synthesis could not open the default vault");
      }
    });
    document.getElementById("path-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      setBusy("Checking vault…");
      try {
        await post("/api/vault/open", { path: pathInput.value });
        await awaitApplication();
      } catch (error) {
        setError(error instanceof Error ? error.message : "Synthesis could not open that vault");
      }
    });
  </script>
</body>
</html>`;
}

async function readJson(req: Request): Promise<unknown> {
  const contentType = req.headers.get("Content-Type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Expected an application/json request");
  }
  const declaredLength = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("Request is too large");
  }
  const bytes = new Uint8Array(MAX_REQUEST_BYTES);
  let length = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("Request is too large");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  }
  const body = new TextDecoder().decode(bytes.subarray(0, length));
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request must contain valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createVaultChooserHandler(
  expectedOrigin: string,
  defaultDirectory: string,
  select: (directory: string) => void,
  browse: (defaultDirectory: string) => Promise<string | null> =
    pickVaultDirectory,
  validate: (value: unknown) => Promise<string> =
    validateExistingVaultDirectory,
): (req: Request) => Promise<Response> {
  let hasSelection = false;
  const commit = (directory: string): Response => {
    if (hasSelection) {
      return json({
        error: "A vault is already opening",
        code: "VAULT_OPENING",
      }, 409);
    }
    hasSelection = true;
    select(directory);
    return json({ vaultDirectory: directory });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.origin !== expectedOrigin) {
      return json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = crypto.randomUUID().replaceAll("-", "");
      const headers = securityHeaders(nonce);
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(chooserHtml(defaultDirectory, nonce), { headers });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json({ status: "choosing-vault" });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/vault/")) {
      if (req.headers.get("Origin") !== expectedOrigin) {
        return json(
          { error: "Origin not allowed", code: "ORIGIN_NOT_ALLOWED" },
          403,
        );
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : "Invalid request",
          code: "INVALID_REQUEST",
        }, 400);
      }
      if (!isRecord(body)) {
        return json({
          error: "Request must be a JSON object",
          code: "INVALID_REQUEST",
        }, 400);
      }
      try {
        if (url.pathname === "/api/vault/default") {
          if (Object.keys(body).length !== 0) {
            throw new Error("Default vault request must be empty");
          }
          return commit(resolve(defaultDirectory));
        }
        if (url.pathname === "/api/vault/open") {
          if (Object.keys(body).length !== 1 || !("path" in body)) {
            throw new Error("Vault request must contain only a path");
          }
          return commit(await validate(body.path));
        }
        if (url.pathname === "/api/vault/browse") {
          if (Object.keys(body).length !== 0) {
            throw new Error("Vault browse request must be empty");
          }
          const selected = await browse(defaultDirectory);
          if (selected === null) return json({ cancelled: true });
          return commit(await validate(selected));
        }
      } catch (error) {
        return json({
          error: error instanceof Error
            ? error.message
            : "Synthesis could not open that vault",
          code: "INVALID_VAULT",
        }, 422);
      }
    }
    return json({ error: "Not found", code: "NOT_FOUND" }, 404);
  };
}

export async function chooseVaultAtStartup(
  options: VaultChooserOptions,
): Promise<string> {
  if (!isLoopbackHostname(options.hostname)) {
    throw new Error("The vault chooser is available only on a loopback host");
  }
  const origin = chooserOrigin(options.hostname, options.port);
  let resolveSelection: (directory: string) => void = () => {};
  const selection = new Promise<string>((resolveSelectionPromise) => {
    resolveSelection = resolveSelectionPromise;
  });
  const handler = createVaultChooserHandler(
    origin,
    options.defaultDirectory,
    resolveSelection,
    options.pickDirectory,
  );
  const server = Deno.serve(
    {
      hostname: options.hostname,
      port: options.port,
      signal: options.signal,
    },
    handler,
  );
  let rejectAborted: ((error: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () =>
    rejectAborted?.(new DOMException("Aborted", "AbortError"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    await options.announceAndOpen(
      options.hostname,
      options.port,
      options.openBrowser,
    );
    return await Promise.race([selection, aborted]);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) await server.finished;
    else await server.shutdown();
  }
}
