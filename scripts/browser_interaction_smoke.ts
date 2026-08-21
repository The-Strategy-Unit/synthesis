import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderWikiPage } from "../src/wiki.ts";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitFor<T>(
  action: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function seedWiki(vault: string): Promise<void> {
  const sourceText = "Controlled evidence supports a stable operational fact.";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sourceText),
  );
  const sourceHash = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const sourceDir = `${vault}/sources/${sourceHash}`;
  await Deno.mkdir(sourceDir, { recursive: true });
  await Deno.mkdir(`${vault}/notes`, { recursive: true });
  await Deno.writeTextFile(`${sourceDir}/source.txt`, sourceText);
  await Deno.writeTextFile(
    `${sourceDir}/summary.md`,
    "Short controlled evidence for the reader workspace.\n",
  );
  await Deno.writeTextFile(
    `${sourceDir}/meta.json`,
    JSON.stringify({
      contentHash: sourceHash,
      sourceType: "text",
      sourceUrl: "",
      title: "Controlled operational evidence",
    }) + "\n",
  );
  const source = {
    contentHash: sourceHash,
    title: "Controlled operational evidence",
  };
  await Deno.writeTextFile(
    `${vault}/notes/operational-fact.md`,
    renderWikiPage({
      body: "The controlled operational fact remains stable.",
      links: ["Supporting context"],
      tags: ["operations"],
      title: "Operational fact",
      type: "concept",
    }, [source]),
  );
  await Deno.writeTextFile(
    `${vault}/notes/supporting-context.md`,
    renderWikiPage({
      body: "Supporting context explains how the operational fact is used.",
      links: ["Operational fact"],
      tags: ["operations"],
      title: "Supporting context",
      type: "concept",
    }, [source]),
  );
}

async function browserCommand(): Promise<string> {
  const explicit = Deno.args[0]?.trim();
  const candidates = explicit ? [explicit] : Deno.build.os === "windows"
    ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
    : Deno.build.os === "darwin"
    ? [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    : [
      "ungoogled-chromium",
      "chromium",
      "chromium-browser",
      "google-chrome",
      "microsoft-edge",
    ];
  for (const candidate of candidates) {
    try {
      const output = await new Deno.Command(candidate, {
        args: ["--version"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      if (output.success) return candidate;
    } catch {
      // Try the next known Chromium-family executable.
    }
  }
  throw new Error(
    "No Chromium-family browser found. Pass its executable path: deno task test:browser -- /path/to/chromium",
  );
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpClient {
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: Error) => void;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "CDP command failed"),
        );
      } else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Browser debugging connection closed"));
      }
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to browser debugging")),
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Browser evaluation failed: ${expression}`);
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

async function browserTarget(debugPort: number): Promise<string> {
  const targets = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      return await response.json() as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
    },
    (items) =>
      items.some((item) =>
        item.type === "page" && typeof item.webSocketDebuggerUrl === "string"
      ),
    "Browser debugging endpoint did not become ready",
  );
  return targets.find((item) =>
    item.type === "page" && typeof item.webSocketDebuggerUrl === "string"
  )!.webSocketDebuggerUrl!;
}

async function run(): Promise<void> {
  const executable = await browserCommand();
  const appPort = availablePort();
  const providerPort = availablePort();
  const debugPort = availablePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const vault = await Deno.makeTempDir({ prefix: "synthesis-browser-smoke-" });
  const browserProfile = await Deno.makeTempDir({
    prefix: "synthesis-browser-profile-",
  });
  await seedWiki(vault);

  const app = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", join(PROJECT_DIRECTORY, "scripts/start.ts")],
    cwd: PROJECT_DIRECTORY,
    env: {
      SYNTHESIS_API_BASE: `http://127.0.0.1:${providerPort}/v1`,
      SYNTHESIS_APP_DATA: `${vault}/app-data`,
      SYNTHESIS_EMBED_API_BASE: `http://127.0.0.1:${providerPort}/v1`,
      SYNTHESIS_HOST: "127.0.0.1",
      SYNTHESIS_MODEL_TIMEOUT_MS: "500",
      SYNTHESIS_OPEN_BROWSER: "false",
      SYNTHESIS_PORT: String(appPort),
      SYNTHESIS_PUBLIC_ORIGIN: origin,
      SYNTHESIS_VAULT: vault,
    },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  let browser: Deno.ChildProcess | undefined;
  let client: CdpClient | undefined;
  try {
    await waitFor(
      () => fetch(`${origin}/api/status`).then((response) => response.ok),
      Boolean,
      "Synthesis did not become ready",
    );
    const rebuild = await fetch(`${origin}/api/rebuild`, {
      body: JSON.stringify({ confirm: "REBUILD" }),
      headers: { "Content-Type": "application/json", Origin: origin },
      method: "POST",
    });
    assert.equal(rebuild.status, 200);
    await rebuild.body?.cancel();

    browser = new Deno.Command(executable, {
      args: [
        "--headless=new",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-gpu",
        "--no-default-browser-check",
        "--no-first-run",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${browserProfile}`,
        "about:blank",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    client = await CdpClient.connect(await browserTarget(debugPort));
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: origin });

    await waitFor(
      () =>
        client!.evaluate<number>(
          "document.querySelectorAll('#note-list .note-list-button').length",
        ),
      (count) => count === 2,
      "Wiki pages did not render in the browser",
    );
    await client.evaluate(`(() => {
      const input = document.querySelector('#search-input');
      input.value = 'operational';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await waitFor(
      () =>
        client!.evaluate<string>(
          "document.querySelector('.search-result-relevance')?.textContent ?? ''",
        ),
      (text) => text === "Keyword rank 1",
      "Visible keyword relevance did not render",
    );
    assert.match(
      await client.evaluate<string>(
        "document.querySelector('#search-method')?.textContent ?? ''",
      ),
      /^Keyword search/,
    );

    await client.evaluate(
      "document.querySelector('#connections-view-btn').click()",
    );
    await waitFor(
      () =>
        client!.evaluate<boolean>(
          "document.querySelector('#graph-panel').classList.contains('is-maximized') && document.querySelectorAll('#graph circle.node').length >= 1",
        ),
      Boolean,
      "Connections did not maximise and render",
    );
    assert.equal(
      await client.evaluate<string>(
        "document.querySelector('#graph-maximize').getAttribute('aria-pressed')",
      ),
      "true",
    );
    await client.evaluate("document.querySelector('#graph-fit').click()");
    await waitFor(
      () =>
        client!.evaluate<string>(
          "document.querySelector('#graph > g')?.getAttribute('transform') ?? ''",
        ),
      (transform) => /translate\(.+\) scale\(.+\)/.test(transform),
      "Fit graph did not apply a viewport transform",
    );

    await client.evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    );
    await waitFor(
      () =>
        client!.evaluate<boolean>(
          "!document.querySelector('#graph-panel').classList.contains('is-maximized') && document.activeElement?.id === 'graph-maximize'",
        ),
      Boolean,
      "Escape did not restore the graph and keyboard focus",
    );
    await client.evaluate("document.querySelector('#graph-maximize').click()");
    assert.equal(
      await client.evaluate<boolean>(
        "document.querySelector('#graph-panel').classList.contains('is-maximized')",
      ),
      true,
    );
    await client.evaluate("document.querySelector('#graph-maximize').click()");
    assert.equal(
      await client.evaluate<boolean>(
        "document.querySelector('#graph-panel').classList.contains('is-maximized')",
      ),
      false,
    );

    console.log(
      "Browser interaction smoke passed: relevance, maximise, fit, Escape, and restore.",
    );
  } finally {
    client?.close();
    if (browser) {
      try {
        browser.kill("SIGTERM");
      } catch {
        // The browser may already have exited.
      }
      await browser.status;
    }
    try {
      app.kill("SIGTERM");
    } catch {
      // The app may already have exited after a startup failure.
    }
    await app.status;
    await Deno.remove(browserProfile, { recursive: true });
    await Deno.remove(vault, { recursive: true });
  }
}

await run();
