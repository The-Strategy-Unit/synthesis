import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderWikiPage } from "../src/wiki/wiki.ts";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const ATTEMPT_TIMEOUT_MS = 2_000;
const BROWSER_CONNECT_TIMEOUT_MS = 5_000;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${message} after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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
      const remainingMs = Math.max(1, deadline - Date.now());
      const value = await withTimeout(
        action(),
        Math.min(ATTEMPT_TIMEOUT_MS, remainingMs),
        message,
      );
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
  // A provider-free, disconnected overview catches the original fit/label gap
  // and exercises long titles without touching a user's vault.
  for (let index = 0; index < 32; index++) {
    await Deno.writeTextFile(
      `${vault}/notes/research-${index}.md`,
      renderWikiPage({
        body: "A synthetic research topic for graph readability checks.",
        links: [],
        tags: ["research"],
        title: `Research topic ${
          index + 1
        }: interpreting evidence across populations and settings`,
        type: "concept",
      }, [source]),
    );
  }
}

export function browserExecutableArgument(
  args: readonly string[],
): string | undefined {
  const candidate = args[0] === "--" ? args[1] : args[0];
  return candidate?.trim() || undefined;
}

export function manualQueueSmokeExpression(queuedSources: string): string {
  return `(() => {
    document.querySelector('#add-source-btn').click();
    const sourceType = document.querySelector('#ingest-source-type');
    sourceType.value = 'queue';
    sourceType.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.querySelector('#ingest-input');
    input.value = ${JSON.stringify(queuedSources)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('#manual-queue-list li')];
    return {
      fileHidden: document.querySelector('#source-file-row').classList.contains('hidden'),
      queueVisible: !document.querySelector('#manual-queue-controls').classList.contains('hidden'),
      rows: rows.length,
      waiting: rows.filter(item => item.dataset.state === 'waiting').length,
    };
  })()`;
}

async function browserCommand(): Promise<string> {
  const explicit = browserExecutableArgument(Deno.args);
  if (explicit) return explicit;

  const candidates = Deno.build.os === "windows"
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
      await new Deno.Command(candidate, {
        args: ["--version"],
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      return candidate;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        // The executable launched but did not treat --version as a short command.
        return candidate;
      }
      // Try the next known Chromium-family executable after another launch error.
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
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener(
            "error",
            () => reject(new Error("Could not connect to browser debugging")),
            { once: true },
          );
        }),
        BROWSER_CONNECT_TIMEOUT_MS,
        "Browser debugging connection timed out",
      );
    } catch (error) {
      try {
        socket.close();
      } catch {
        // A socket that never opened may already be closed by the runtime.
      }
      throw error;
    }
    return new CdpClient(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return withTimeout(
      response,
      CDP_COMMAND_TIMEOUT_MS,
      `Browser command ${method} timed out`,
    ).finally(() => this.#pending.delete(id));
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

async function stopProcess(
  process: Deno.ChildProcess,
  name: string,
): Promise<void> {
  try {
    process.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
  try {
    await withTimeout(
      process.status,
      PROCESS_STOP_TIMEOUT_MS,
      `${name} did not stop`,
    );
    return;
  } catch {
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may have exited between the deadline and forced stop.
    }
  }
  await withTimeout(
    process.status,
    PROCESS_STOP_TIMEOUT_MS,
    `${name} did not stop after forced termination`,
  );
}

async function run(): Promise<void> {
  console.log("Browser smoke: locating a Chromium-family browser.");
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
    console.log("Browser smoke: starting Synthesis with a temporary vault.");
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

    console.log("Browser smoke: launching the headless browser.");
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

    console.log("Browser smoke: waiting for the seeded wiki.");
    await waitFor(
      () =>
        client!.evaluate<number>(
          "document.querySelectorAll('#note-list .note-list-button').length",
        ),
      (count) => count === 34,
      "Wiki pages did not render in the browser",
    );
    console.log("Browser smoke: checking the manual source queue.");
    const queuedSources = [
      "dQw4w9WgXcQ",
      "https://youtu.be/9bZkp7q19f0",
    ].join("\n");
    const queueState = await client.evaluate<{
      fileHidden: boolean;
      queueVisible: boolean;
      rows: number;
      waiting: number;
    }>(manualQueueSmokeExpression(queuedSources));
    assert.deepEqual(queueState, {
      fileHidden: true,
      queueVisible: true,
      rows: 2,
      waiting: 2,
    });
    await client.evaluate(
      "document.querySelector('#source-panel-close').click()",
    );

    console.log("Browser smoke: checking search relevance and graph controls.");
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
    assert.equal(
      await client.evaluate<string>(
        "getComputedStyle(document.querySelector('#graph .link-explicit')).stroke",
      ),
      "rgb(123, 184, 255)",
      "Reviewed wiki links were not rendered blue",
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

    await waitFor(
      () =>
        client!.evaluate<boolean>(
          `[...document.querySelectorAll('#graph .label')]
        .some(label => getComputedStyle(label).display !== 'none')`,
        ),
      Boolean,
      "The fitted graph hid every page title",
    );
    const focusState = await client.evaluate<Record<string, boolean>>(`(() => {
        const node = document.querySelector('#graph circle.node');
        node.dispatchEvent(new FocusEvent('focus'));
        const label = [...document.querySelectorAll('#graph .label')]
          .find(item => item.__data__.id === node.__data__.id);
        return {
          keyboardAddressable: node.getAttribute('role') === 'button' &&
            node.getAttribute('tabindex') === '0',
          labelVisible: !!label && getComputedStyle(label).display !== 'none',
          labelScreenSized: !!label && getComputedStyle(label).fontSize === '13px',
          labelOutsideZoomLayer: !!label && label.parentNode.parentNode.id === 'graph',
          tooltipMatches: document.querySelector('#graph-tooltip').textContent ===
            node.__data__.title,
        };
      })()`);
    assert.deepEqual(focusState, {
      keyboardAddressable: true,
      labelVisible: true,
      labelScreenSized: true,
      labelOutsideZoomLayer: true,
      tooltipMatches: true,
    });
    await client.evaluate(
      `document.querySelector('#graph circle.node').dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))`,
    );
    assert.match(
      await client.evaluate<string>(
        "document.querySelector('#graph-page-list').textContent",
      ),
      /Reviewed wiki link/,
    );
    assert.equal(
      await client.evaluate<number>(
        "document.querySelectorAll('#graph-page-list button').length",
      ),
      1,
      "Focus should list only connected pages",
    );
    await client.evaluate(
      "document.querySelector('#graph-page-list button').click()",
    );
    assert.equal(
      await client.evaluate<string>("document.activeElement.id"),
      "graph-focus-open",
    );
    await client.evaluate(
      "document.querySelector('#graph-focus-open').click()",
    );
    await waitFor(
      () =>
        client!.evaluate<boolean>(
          "document.querySelector('#graph-panel').classList.contains('hidden') && !document.querySelector('#reader-panel').classList.contains('hidden')",
        ),
      Boolean,
      "Opening a graph neighbour did not open the wiki page",
    );
    await client.evaluate(
      "document.querySelector('#connections-view-btn').click()",
    );
    await client.evaluate(
      "document.querySelector('#graph-focus-clear').click()",
    );
    await client.evaluate(
      "document.querySelector('#graph-search-clear').click()",
    );
    await waitFor(
      () =>
        client!.evaluate<number>(
          "document.querySelectorAll('#graph circle.node').length",
        ),
      (count) => count === 34,
      "Clearing search did not restore the overview",
    );
    await client.evaluate("document.querySelector('#graph-fit').click()");
    assert.equal(
      await client.evaluate<boolean>(`(() => {
      const labels = [...document.querySelectorAll('#graph .label')]
        .filter(label => getComputedStyle(label).display !== 'none');
      const boxes = labels.map(label => label.getBoundingClientRect());
      return boxes.length > 1 && boxes.every((a, i) => boxes.slice(i + 1).every(b =>
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
    })()`),
      true,
      "Overview titles must be visible without overlapping",
    );
    await client.evaluate(`(() => {
      const input = document.querySelector('#graph-page-filter');
      input.value = 'no such page';
      input.dispatchEvent(new Event('input'));
    })()`);
    assert.equal(
      await client.evaluate<number>(
        "document.querySelectorAll('#graph-page-list button').length",
      ),
      0,
      "Title filter did not handle no matches",
    );
    await client.evaluate(`(() => {
      const input = document.querySelector('#graph-page-filter');
      input.value = '';
      input.dispatchEvent(new Event('input'));
    })()`);

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

    console.log("Browser smoke: checking long-operation feedback.");
    await client.evaluate(`(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (String(input).endsWith('/api/lint')) {
          return new Promise((resolve, reject) => {
            setTimeout(() => originalFetch(input, init).then(resolve, reject), 500);
          });
        }
        return originalFetch(input, init);
      };
      document.querySelector('#lint-open-btn').click();
    })()`);
    await waitFor(
      () =>
        client!.evaluate<boolean>(
          "document.querySelector('#lint-status').classList.contains('operation-active') && document.querySelector('#lint-status').getAttribute('aria-busy') === 'true' && !document.querySelector('#operation-feedback').classList.contains('hidden') && document.querySelector('#operation-feedback').getAttribute('aria-busy') === 'true'",
        ),
      Boolean,
      "Long-operation progress did not become visible",
    );
    await waitFor(
      () =>
        client!.evaluate<boolean>(
          "!document.querySelector('#lint-status').classList.contains('operation-active') && document.querySelector('#lint-status').getAttribute('aria-busy') === 'false' && document.querySelector('#operation-feedback').classList.contains('hidden') && document.querySelector('#operation-feedback').getAttribute('aria-busy') === 'false'",
        ),
      Boolean,
      "Long-operation progress did not clear after completion",
    );

    console.log(
      "Browser interaction smoke passed: relevance, graph controls, and operation feedback.",
    );
  } finally {
    client?.close();
    if (browser) await stopProcess(browser, "Browser");
    await stopProcess(app, "Synthesis");
    await Deno.remove(browserProfile, { recursive: true });
    await Deno.remove(vault, { recursive: true });
  }
}

if (import.meta.main) await run();
