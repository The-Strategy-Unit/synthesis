import { config, dbPath, notesDir } from "./src/config.ts";
import { slugify } from "./src/utils.ts";
import { DB } from "./src/db.ts";
import { getPlaylistVideos, ingestText, ingestYouTube } from "./src/ingest.ts";
import { distil, integrate, noteToMarkdown, summarise } from "./src/distil.ts";

const vault_dir = config.vaultDir;
const db_path = dbPath();

try {
  await Deno.stat(vault_dir);
} catch {
  console.error(`Vault directory not found: ${vault_dir}`);
  console.error(`Run \`mkdir -p ${vault_dir}/notes\` first.`);
  Deno.exit(1);
}
await Deno.mkdir(notesDir(), { recursive: true });

const db = new DB(db_path);

// --- Shared ingest logic ---

async function processSingleSource(
  ingested: { transcript: string; sourceUrl: string; title: string },
  isText: boolean,
  send: (stage: string, data?: unknown) => void,
): Promise<{
  notes: Array<{ id: number; title: string }>;
  newCount: number;
  mergeCount: number;
  contradictCount: number;
}> {
  send("summarising");
  const summary = await summarise(
    ingested.transcript,
    config.llm.apiBase,
    config.llm.apiKey,
    config.llm.summaryModel,
  );
  send("summarised");

  send("distilling");
  const distilled = await distil(
    summary,
    ingested.title,
    ingested.sourceUrl,
    config.llm.apiBase,
    config.llm.apiKey,
    config.llm.model,
  );
  send("distilled", { noteCount: distilled.notes.length });

  const existingNotes = db.getAllNotes().map((n) => ({
    id: n.id,
    title: n.title,
  }));
  const decisions = await integrate(
    distilled.notes,
    existingNotes,
    config.llm.apiBase,
    config.llm.apiKey,
    config.llm.model,
  );

  send("embedding");
  const allNotes: Array<{ id: number; title: string }> = [];
  let newCount = 0;
  let mergeCount = 0;
  let contradictCount = 0;

  for (let i = 0; i < distilled.notes.length; i++) {
    const note = distilled.notes[i];
    const decision = decisions[i];

    if (
      decision.action === "merge" ||
      decision.action === "contradict"
    ) {
      const existing = db.getNote(decision.existing_id!);
      if (existing) {
        const existingContent = await Deno.readTextFile(existing.file_path);
        const suffix = decision.action === "contradict"
          ? `\n\n> ⚠️ **Contradicts:** ${note.body}\n`
          : `\n\n> **Addition:** ${note.body}\n`;
        const updatedContent = existingContent + suffix;
        await Deno.writeTextFile(existing.file_path, updatedContent);
        db.indexNote(existing.id, existing.title, updatedContent);
        try {
          await db.embedAndStore(
            existing.id,
            existing.title,
            updatedContent,
            config.embed.apiBase,
            config.embed.apiKey,
            config.embed.model,
          );
        } catch (err) {
          console.error(`Re-embedding failed: ${errMsg(err)}`);
        }
        allNotes.push({ id: existing.id, title: existing.title });
        if (decision.action === "merge") mergeCount++;
        else contradictCount++;
        continue;
      }
    }

    const safeTitle = slugify(note.title);
    const filePath = `${notesDir()}/${safeTitle}.md`;
    const md = noteToMarkdown(note, ingested.sourceUrl, ingested.title);
    await Deno.writeTextFile(filePath, md);
    const noteId = db.addNote(
      note.title,
      filePath,
      ingested.sourceUrl,
      isText ? "text" : "youtube",
    );
    db.indexNote(noteId, note.title, note.body);
    try {
      await db.embedAndStore(
        noteId,
        note.title,
        note.body,
        config.embed.apiBase,
        config.embed.apiKey,
        config.embed.model,
      );
    } catch (err) {
      console.error(`Embedding failed for note ${noteId}: ${errMsg(err)}`);
    }
    allNotes.push({ id: noteId, title: note.title });
    newCount++;
  }

  return { notes: allNotes, newCount, mergeCount, contradictCount };
}

function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s.trim());
}

// --- Server ---

Deno.serve({ port: config.port }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path.startsWith("/api/")) {
    // --- Config ---
    if (path === "/api/config" && method === "GET") {
      return json({
        labelZoomThreshold: config.ui.labelZoomThreshold,
        sliderMin: config.ui.sliderMin,
        sliderMax: config.ui.sliderMax,
        sliderStep: config.ui.sliderStep,
        defaultSimilarity: config.link.similarityThreshold,
        port: config.port,
        llm: {
          model: config.llm.model,
          summaryModel: config.llm.summaryModel,
        },
        embed: {
          model: config.embed.model,
          dimensions: config.embed.dimensions,
        },
        link: {
          similarityThreshold: config.link.similarityThreshold,
          k: config.link.k,
        },
        ingest: {
          maxChars: config.ingest.maxChars,
          overlap: config.ingest.overlap,
        },
        search: {
          resultLimit: config.search.resultLimit,
        },
      });
    }

    if (path === "/api/status" && method === "GET") {
      return json({
        status: "ok",
        vault: vault_dir,
        models: { llm: config.llm.model, embed: config.embed.model },
      });
    }

    if (path === "/api/notes" && method === "GET") {
      return json({ notes: db.getAllNotes() });
    }

    if (path.startsWith("/api/notes/") && method === "GET") {
      const id = parseInt(path.split("/")[3]);
      const note = db.getNote(id);
      if (!note) return json({ error: "Not found" }, 404);
      const content = await Deno.readTextFile(note.file_path);
      const related = db.getRelatedNotes(id);
      return json({ ...note, content, related });
    }

    // --- Ingest single (URL or text) via SSE ---

    if (path === "/api/ingest" && method === "POST") {
      const body = await req.json();
      const source = (body.url ?? body.text ?? "").trim();
      if (!source) return json({ error: "Provide 'url' or 'text'" }, 400);

      const textInput = !isUrl(source);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (stage: string, data?: unknown) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ stage, ...data })}\n\n`),
            );
          };

          try {
            let ingested;
            if (textInput) {
              send("ingesting", { title: "Processing text..." });
              ingested = ingestText(
                body.title ?? "Pasted text",
                source,
              );
              send("ingested", { title: ingested.title });
            } else {
              send("ingesting", { title: "Downloading subtitles..." });
              ingested = await ingestYouTube(source);
              send("ingested", { title: ingested.title });
            }

            const result = await processSingleSource(ingested, textInput, send);

            send("integrating");
            send("integrated", {
              new: result.newCount,
              merge: result.mergeCount,
              contradict: result.contradictCount,
            });

            send("linking");
            try {
              db.computeLinks(config.link.similarityThreshold);
            } catch (err) {
              console.error(`Link computation failed: ${errMsg(err)}`);
            }

            send("done", { notes: result.notes });
            controller.close();
          } catch (err) {
            send("error", { error: errMsg(err) });
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // --- Ingest playlist via SSE ---

    if (path === "/api/ingest/playlist" && method === "POST") {
      const body = await req.json();
      const { url: playlistUrl } = body;
      if (!playlistUrl) return json({ error: "Provide 'url'" }, 400);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (stage: string, data?: unknown) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ stage, ...data })}\n\n`),
            );
          };

          try {
            send("ingesting", { title: "Fetching playlist..." });
            let videoUrls: string[];
            try {
              videoUrls = await getPlaylistVideos(playlistUrl);
            } catch (err) {
              send("error", { error: errMsg(err) });
              controller.close();
              return;
            }
            send("ingested", { title: `${videoUrls.length} videos found` });

            const allNotes: Array<{ id: number; title: string }> = [];
            const errors: string[] = [];
            let totalNew = 0;
            let totalMerge = 0;
            let totalContradict = 0;

            for (let vi = 0; vi < videoUrls.length; vi++) {
              const videoUrl = videoUrls[vi];
              send("distilling", {
                title: `Video ${vi + 1}/${videoUrls.length}`,
              });

              try {
                const ingested = await ingestYouTube(videoUrl);
                const result = await processSingleSource(ingested, false, send);
                allNotes.push(...result.notes);
                totalNew += result.newCount;
                totalMerge += result.mergeCount;
                totalContradict += result.contradictCount;
              } catch (err) {
                errors.push(`${videoUrl}: ${errMsg(err)}`);
              }
            }

            send("integrating");
            send("integrated", {
              new: totalNew,
              merge: totalMerge,
              contradict: totalContradict,
            });

            send("linking");
            try {
              db.computeLinks(config.link.similarityThreshold);
            } catch (err) {
              console.error(`Link computation failed: ${errMsg(err)}`);
            }

            send("done", { notes: allNotes, errors });
            controller.close();
          } catch (err) {
            send("error", { error: errMsg(err) });
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // --- Search ---
    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const mode = url.searchParams.get("mode") ?? "semantic";
      if (!q) return json({ results: [], query: "" });

      try {
        let results: Array<
          { id: number; title: string; score: number; matchType: string }
        >;

        if (mode === "keyword") {
          results = db.searchKeyword(q).map((r) => ({
            id: r.id,
            title: r.title,
            score: 1 / (1 + Math.abs(r.rank)),
            matchType: "keyword",
          }));
        } else {
          const qEmb = await DB.embedText(
            q,
            config.embed.apiBase,
            config.embed.apiKey,
            config.embed.model,
          );
          results = db.searchSemantic(qEmb).map((r) => ({
            id: r.note_id,
            title: r.title,
            score: r.similarity,
            matchType: "semantic",
          }));
        }

        return json({ results, query: q });
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }
    }

    // --- Graph ---
    if (path === "/api/graph" && method === "GET") {
      const notes = db.getAllNotes();
      const links = db.getLinks();
      return json({
        nodes: notes.map((n) => ({ id: n.id, title: n.title })),
        links: links.map((l) => ({
          source: l.source,
          target: l.target,
          similarity: l.similarity,
        })),
      });
    }

    return json({ error: "Not found" }, 404);
  }

  return serveStatic(path);
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function serveStatic(path: string): Promise<Response> {
  if (path === "/") path = "/index.html";
  const webRoot = await Deno.realPath("web");
  const candidate = await Deno.realPath(`web${path}`).catch(() => null);
  if (!candidate || !candidate.startsWith(webRoot)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const file = await Deno.readFile(candidate);
    return new Response(file, {
      headers: { "Content-Type": getContentType(path) },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
