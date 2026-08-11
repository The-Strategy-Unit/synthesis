import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderWikiPage } from "../src/wiki.ts";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

async function seedWiki(vault: string): Promise<void> {
  const sourceText = "Controlled evidence supports a stable operational fact.";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sourceText),
  );
  const sourceHash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
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
      body: "Supporting context explains how the fact is used.",
      links: ["Operational fact"],
      tags: ["operations"],
      title: "Supporting context",
      type: "concept",
    }, [source]),
  );
}

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
  const origin = `http://127.0.0.1:${port}`;
  await seedWiki(vault);
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
      SYNTHESIS_PUBLIC_ORIGIN: origin,
      SYNTHESIS_VAULT: vault,
    },
    stdout: "null",
    stderr: "null",
  }).spawn();

  try {
    await fetchWhenReady(`${origin}/`);
    const rebuild = await fetch(`${origin}/api/rebuild`, {
      body: JSON.stringify({ confirm: "REBUILD" }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(rebuild.status, 200);
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
    assert.match(index, /id="reader-panel"/);
    assert.match(index, /id="evidence-panel" class="hidden"/);
    assert.match(index, /id="graph-panel" class="hidden"/);
    assert.match(index, /id="review-workspace" class="hidden"/);
    assert.match(index, /id="proposal-decision-summary" role="status"/);
    assert.match(index, /id="ingest-stages"/);
    assert.doesNotMatch(index, /id="review-modal"/);
    assert.match(index, /<dialog id="ask-modal" class="modal"/);
    assert.match(index, /<dialog id="sources-modal" class="modal"/);
    assert.doesNotMatch(index, /<div id="[^"]+-modal" class="modal/);
    assert.match(style, /#primary-nav/);
    assert.match(style, /\.source-panel/);
    assert.match(style, /#knowledge-layout/);
    assert.match(style, /\.proposal-change-decision/);
    assert.match(style, /\.modal::backdrop/);
    assert.match(bundle, /add-source-btn/);
    assert.match(bundle, /reader_workspace/);
    assert.match(bundle, /review_workflow/);
    assert.equal(status.status, "ok");

    const notes = await fetch(`${origin}/api/notes`).then((response) =>
      response.json()
    );
    assert.equal(notes.notes.length, 2);
    const selected = notes.notes.find((note: { title: string }) =>
      note.title === "Operational fact"
    );
    assert.ok(selected);
    const page = await fetch(`${origin}/api/notes/${selected.id}`).then(
      (response) => response.json(),
    );
    assert.equal(page.sources.length, 1);
    assert.equal(page.claims.length, 1);
    assert.deepEqual(
      page.related.map((item: { title: string }) => item.title),
      [
        "Supporting context",
      ],
    );
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
