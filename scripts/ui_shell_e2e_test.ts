import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import denoConfig from "../deno.json" with { type: "json" };

import { renderWikiPage } from "../src/wiki/wiki.ts";

const PROJECT_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

async function seedWiki(vault: string, extraPageTitle?: string): Promise<void> {
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
  await Deno.writeTextFile(
    `${vault}/vault.json`,
    JSON.stringify(
      {
        formatVersion: 1,
        vaultId: "3f4db942-2253-43ba-8f8f-808fad02f10f",
        createdAt: "2026-09-08T10:30:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );
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
  if (extraPageTitle) {
    await Deno.writeTextFile(
      `${vault}/notes/second-vault-only.md`,
      renderWikiPage({
        body: "This page exists only in the second vault.",
        links: [],
        tags: ["switch-test"],
        title: extraPageTitle,
        type: "concept",
      }, [source]),
    );
  }
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
  const appData = `${vault}/app-data`;
  const origin = `http://127.0.0.1:${port}`;
  const usagePeriod = new Date().toISOString().slice(0, 7);
  await seedWiki(vault);
  await Deno.mkdir(appData, { recursive: true });
  await Deno.writeTextFile(
    `${appData}/provider-usage.json`,
    JSON.stringify({
      version: 1,
      period: usagePeriod,
      outputTokens: 1_000_001,
    }),
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      join(PROJECT_DIRECTORY, "scripts/start.ts"),
    ],
    cwd: PROJECT_DIRECTORY,
    env: {
      SYNTHESIS_APP_DATA: appData,
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
    const [index, style, bundle, status, usage] = await Promise.all([
      fetchWhenReady(`${origin}/`).then((response) => response.text()),
      fetchWhenReady(`${origin}/style.css`).then((response) => response.text()),
      fetchWhenReady(`${origin}/app.bundle.js`).then((response) =>
        response.text()
      ),
      fetchWhenReady(`${origin}/api/status`).then((response) =>
        response.json()
      ),
      fetchWhenReady(`${origin}/api/provider/usage`).then((response) =>
        response.json()
      ),
    ]);

    assert.match(index, /id="primary-nav"/);
    assert.match(index, /id="add-source-btn"/);
    assert.match(index, /id="provider-usage-warning" class="hidden"/);
    assert.match(index, /id="source-panel" class="source-panel hidden"/);
    assert.match(index, /id="reader-panel"/);
    assert.match(index, /id="evidence-panel" class="hidden"/);
    assert.match(index, /id="graph-panel" class="hidden"/);
    assert.match(index, /id="graph-maximize" type="button"/);
    assert.match(index, /id="page-list-toggle"/);
    assert.match(index, /id="nav-toggle"/);
    assert.match(index, /id="workspace-collapse"/);
    assert.match(index, /id="graph-fit" type="button"/);
    assert.match(index, /id="graph-search-summary" role="status"/);
    assert.match(index, /id="graph-search-clear" type="button"/);
    assert.match(index, /id="graph-focus-summary" role="status"/);
    assert.match(index, /id="graph-focus-open" type="button"/);
    assert.match(index, /id="graph-focus-clear" type="button"/);
    assert.match(index, /aria-labelledby="graph-directory-title"/);
    assert.match(index, /id="graph-page-filter" type="search"/);
    assert.match(index, /id="graph-page-list"/);
    assert.match(index, /id="review-workspace" class="hidden"/);
    assert.match(index, /id="proposal-decision-summary" role="status"/);
    assert.match(index, /id="proposal-include-all"/);
    assert.match(index, /id="ingest-stages"/);
    assert.match(index, /id="manual-queue-controls"/);
    assert.match(index, /id="trusted-batch-controls"/);
    assert.match(index, /id="proposal-reprocess"/);
    assert.match(index, /id="rebuild-semantic-btn"/);
    assert.match(index, /value="trusted-batch"/);
    assert.match(index, /value="queue"/);
    assert.doesNotMatch(index, /id="review-modal"/);
    assert.match(index, /<dialog id="ask-modal" class="modal"/);
    assert.match(index, /<dialog id="sources-modal" class="modal"/);
    assert.doesNotMatch(index, /<div id="[^"]+-modal" class="modal/);
    assert.match(style, /#primary-nav/);
    assert.match(style, /#provider-usage-warning/);
    assert.match(style, /\.source-panel/);
    assert.match(style, /#knowledge-layout/);
    assert.match(style, /#graph-panel\.is-maximized/);
    assert.match(style, /\.proposal-change-decision/);
    assert.match(style, /\.modal::backdrop/);
    assert.match(bundle, /add-source-btn/);
    assert.match(bundle, /reader_workspace/);
    assert.match(bundle, /provider\/usage/);
    assert.match(bundle, /review_workflow/);
    assert.match(bundle, /searchContextGraph/);
    assert.match(bundle, /graphFocusNodeIds/);
    assert.match(bundle, /graphLabelLayout/);
    assert.match(bundle, /graphNeighbourRows/);
    assert.match(bundle, /setGraphMaximized/);
    assert.match(bundle, /fitGraphToViewport/);
    assert.match(bundle, /Retry with keyword search/);
    assert.match(bundle, /Semantic similarity/);
    assert.match(bundle, /\/api\/ingest\/batch/);
    assert.deepEqual(status, { status: "ok", version: denoConfig.version });
    assert.deepEqual(usage.usage, {
      period: usagePeriod,
      outputTokens: 1_000_001,
      warningThreshold: 1_000_000,
      hasWarning: true,
    });

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

Deno.test("the startup GUI opens an existing vault", async () => {
  const port = availablePort();
  const root = await Deno.makeTempDir({ prefix: "synthesis-vault-chooser-" });
  const vault = join(root, "chosen-vault");
  const secondVault = join(root, "second-vault");
  const origin = `http://127.0.0.1:${port}`;
  await seedWiki(vault);
  await seedWiki(secondVault, "Second vault only");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      join(PROJECT_DIRECTORY, "scripts/start.ts"),
    ],
    cwd: PROJECT_DIRECTORY,
    env: {
      SYNTHESIS_APP_DATA: join(root, "app-data"),
      SYNTHESIS_HOST: "127.0.0.1",
      SYNTHESIS_OPEN_BROWSER: "false",
      SYNTHESIS_PORT: String(port),
      SYNTHESIS_VAULT: "",
    },
    stdout: "null",
    stderr: "null",
  }).spawn();

  try {
    const chooser = await fetchWhenReady(`${origin}/`);
    assert.match(await chooser.text(), /<h1>Open a vault<\/h1>/);
    assert.deepEqual(
      await fetchWhenReady(`${origin}/api/status`).then((response) =>
        response.json()
      ),
      { status: "choosing-vault" },
    );

    const opened = await fetch(`${origin}/api/vault/open`, {
      body: JSON.stringify({ path: vault }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).vaultDirectory, vault);

    let status = "";
    for (let attempt = 0; attempt < 200 && status !== "ok"; attempt++) {
      try {
        status = await fetch(`${origin}/api/status`).then(async (response) =>
          (await response.json()).status
        );
      } catch {
        // The startup chooser and application briefly exchange the port.
      }
      if (status !== "ok") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(status, "ok");
    const rebuild = await fetch(`${origin}/api/rebuild`, {
      body: JSON.stringify({ confirm: "REBUILD" }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(rebuild.status, 200);
    const notes = await fetch(`${origin}/api/notes`).then((response) =>
      response.json()
    );
    assert.equal(notes.notes.length, 2);

    const appConfig = await fetch(`${origin}/api/config`).then((response) =>
      response.json()
    );
    assert.equal(appConfig.vaultSwitchEnabled, true);
    const switching = await fetch(`${origin}/api/vault/switch`, {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(switching.status, 202);
    assert.deepEqual(await switching.json(), { status: "switching" });

    status = "";
    for (
      let attempt = 0;
      attempt < 200 && status !== "choosing-vault";
      attempt++
    ) {
      try {
        status = await fetch(`${origin}/api/status`).then(async (response) =>
          (await response.json()).status
        );
      } catch {
        // The application and chooser briefly exchange the port.
      }
      if (status !== "choosing-vault") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(status, "choosing-vault");
    assert.match(
      await fetch(`${origin}/`).then((response) => response.text()),
      /Current vault closed safely/,
    );

    const openedSecond = await fetch(`${origin}/api/vault/open`, {
      body: JSON.stringify({ path: secondVault }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(openedSecond.status, 200);
    await openedSecond.body?.cancel();
    status = "";
    for (let attempt = 0; attempt < 200 && status !== "ok"; attempt++) {
      try {
        status = await fetch(`${origin}/api/status`).then(async (response) =>
          (await response.json()).status
        );
      } catch {
        // The chooser and next application briefly exchange the port.
      }
      if (status !== "ok") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(status, "ok");
    const secondRebuild = await fetch(`${origin}/api/rebuild`, {
      body: JSON.stringify({ confirm: "REBUILD" }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(secondRebuild.status, 200);
    const secondNotes = await fetch(`${origin}/api/notes`).then((response) =>
      response.json()
    );
    assert.equal(secondNotes.notes.length, 3);
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited after a startup failure.
    }
    await child.status;
    await Deno.remove(root, { recursive: true });
  }
});
