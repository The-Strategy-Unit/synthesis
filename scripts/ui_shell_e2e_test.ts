import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function fetchWhenReady(url: string): Promise<Response> {
  let lastError: unknown = new Error("Synthesis did not become ready");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Synthesis returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

Deno.test("the running app serves the task-based UI shell", async () => {
  const port = availablePort();
  const vault = await Deno.makeTempDir({ prefix: "synthesis-ui-shell-" });
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      join(PROJECT_DIRECTORY, "scripts/start.ts"),
    ],
    cwd: PROJECT_DIRECTORY,
    env: {
      SYNTHESIS_APP_DATA: `${vault}/app-data`,
      SYNTHESIS_HOST: "127.0.0.1",
      SYNTHESIS_OPEN_BROWSER: "false",
      SYNTHESIS_PORT: String(port),
      SYNTHESIS_VAULT: vault,
    },
    stdout: "null",
    stderr: "null",
  }).spawn();

  try {
    const origin = `http://127.0.0.1:${port}`;
    const [index, style, bundle, status] = await Promise.all([
      fetchWhenReady(`${origin}/`).then((response) => response.text()),
      fetchWhenReady(`${origin}/style.css`).then((response) => response.text()),
      fetchWhenReady(`${origin}/app.bundle.js`).then((response) =>
        response.text()
      ),
      fetchWhenReady(`${origin}/api/status`).then((response) =>
        response.json()
      ),
    ]);

    assert.match(index, /id="primary-nav"/);
    assert.match(index, /id="add-source-btn"/);
    assert.match(index, /id="source-panel" class="source-panel hidden"/);
    assert.match(style, /#primary-nav/);
    assert.match(style, /\.source-panel/);
    assert.match(bundle, /add-source-btn/);
    assert.equal(status.status, "ok");
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited after a startup failure.
    }
    await child.status;
    await Deno.remove(vault, { recursive: true });
  }
});
