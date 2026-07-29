import { config, dbPath, notesDir } from "./src/config.ts";
import { DB } from "./src/db.ts";
import { getPlaylistVideos, ingestText, ingestYouTube } from "./src/ingest.ts";
import { distil, noteToMarkdown, sanitizeTitle } from "./src/distil.ts";
import { computeLinks, embedAndStore } from "./src/embed.ts";
import { search } from "./src/search.ts";

const vault_dir = config.vaultDir;
const db_path = dbPath();

try {
  await Deno.stat(vault_dir);
} catch {
  console.error(`Vault directory not found: ${vault_dir}`);
  console.error("Run `mkdir -p ${HOME}/Synthesis/notes` first.");
  Deno.exit(1);
}
await Deno.mkdir(notesDir(), { recursive: true });

const db = new DB(db_path);

Deno.serve({ port: config.port }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path.startsWith("/api/")) {
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

    if (path === "/api/ingest" && method === "POST") {
      const body = await req.json();
      const { url: srcUrl, text, title } = body;

      let ingested;
      try {
        if (srcUrl) ingested = await ingestYouTube(srcUrl);
        else if (text) ingested = await ingestText(title ?? "Untitled", text);
        else return json({ error: "Provide 'url' or 'text'" }, 400);
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }

      let distilled;
      try {
        distilled = await distil(
          ingested.transcript,
          ingested.title,
          ingested.sourceUrl,
          config.llm.apiBase,
          config.llm.apiKey,
          config.llm.model,
        );
      } catch (err) {
        return json({ error: `Distillation failed: ${errMsg(err)}` }, 500);
      }

      const savedNotes: Array<{ id: number; title: string }> = [];
      for (const note of distilled.notes) {
        const safeTitle = sanitizeTitle(note.title);
        const filePath = `${notesDir()}/${safeTitle}.md`;
        const md = noteToMarkdown(note, ingested.sourceUrl, ingested.title);
        await Deno.writeTextFile(filePath, md);

        const noteId = db.addNote(
          note.title,
          filePath,
          ingested.sourceUrl,
          srcUrl ? "youtube" : "text",
        );
        db.indexNote(noteId, note.title, note.body);

        try {
          await embedAndStore(
            noteId,
            note.title,
            note.body,
            db,
            config.embed.apiBase,
            config.embed.apiKey,
            config.embed.model,
          );
        } catch (err) {
          console.error(`Embedding failed for note ${noteId}: ${errMsg(err)}`);
        }

        savedNotes.push({ id: noteId, title: note.title });
      }

      try {
        await computeLinks(db, config.link.similarityThreshold);
      } catch (err) {
        console.error(`Link computation failed: ${errMsg(err)}`);
      }

      return json({
        title: ingested.title,
        summary: distilled.summary,
        notes: savedNotes,
      });
    }

    if (path === "/api/ingest/playlist" && method === "POST") {
      const body = await req.json();
      const { url: playlistUrl } = body;
      if (!playlistUrl) return json({ error: "Provide 'url'" }, 400);

      let videoUrls: string[];
      try {
        videoUrls = await getPlaylistVideos(playlistUrl);
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }

      const allNotes: Array<{ id: number; title: string }> = [];
      const errors: string[] = [];

      for (const videoUrl of videoUrls) {
        try {
          const ingested = await ingestYouTube(videoUrl);
          const distilled = await distil(
            ingested.transcript,
            ingested.title,
            ingested.sourceUrl,
            config.llm.apiBase,
            config.llm.apiKey,
            config.llm.model,
          );

          for (const note of distilled.notes) {
            const safeTitle = sanitizeTitle(note.title);
            const filePath = `${notesDir()}/${safeTitle}.md`;
            const md = noteToMarkdown(note, ingested.sourceUrl, ingested.title);
            await Deno.writeTextFile(filePath, md);

            const noteId = db.addNote(
              note.title,
              filePath,
              ingested.sourceUrl,
              "youtube",
            );
            db.indexNote(noteId, note.title, note.body);

            try {
              await embedAndStore(
                noteId,
                note.title,
                note.body,
                db,
                config.embed.apiBase,
                config.embed.apiKey,
                config.embed.model,
              );
            } catch (err) {
              console.error(
                `Embedding failed for note ${noteId}: ${errMsg(err)}`,
              );
            }

            allNotes.push({ id: noteId, title: note.title });
          }
        } catch (err) {
          errors.push(`${videoUrl}: ${errMsg(err)}`);
        }
      }

      try {
        await computeLinks(db, config.link.similarityThreshold);
      } catch (err) {
        console.error(`Link computation failed: ${errMsg(err)}`);
      }

      return json({ videos: videoUrls.length, notes: allNotes, errors });
    }

    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q) return json({ results: [], query: "" });
      try {
        const results = await search(
          q,
          db,
          config.embed.apiBase,
          config.embed.apiKey,
          config.embed.model,
        );
        return json({ results, query: q });
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }
    }

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
  const filepath = `web${path}`;
  try {
    const file = await Deno.readFile(filepath);
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
