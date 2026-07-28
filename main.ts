// Synthesis - local-first knowledge base
// ingest → distil → embed → search

import { DB } from "./src/db.ts";
import { getPlaylistVideos, ingestText, ingestYouTube } from "./src/ingest.ts";
import { distil, noteToMarkdown, sanitizeTitle } from "./src/distil.ts";
import { computeLinks, embedAndStore } from "./src/embed.ts";
import { search } from "./src/search.ts";

const vault_dir = Deno.env.get("SYNTHESIS_VAULT") ??
  `${Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "."}/Synthesis`;
const db_path = `${vault_dir}/synthesis.db`;

try {
  await Deno.stat(vault_dir);
} catch {
  console.error(`Vault directory not found: ${vault_dir}`);
  console.error("Run `mkdir -p ${HOME}/Synthesis/notes` first.");
  Deno.exit(1);
}
await Deno.mkdir(`${vault_dir}/notes`, { recursive: true });

const db = new DB(db_path);

const api_base = Deno.env.get("synthesis_api_base") ??
  "http://localhost:11434/v1";
const api_key = Deno.env.get("synthesis_api_key") ?? "ollama";
const llm_model = Deno.env.get("synthesis_llm_model") ?? "qwen3.6:27b";
const embed_model = Deno.env.get("synthesis_embed_model") ??
  "qwen3-embedding:8b";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // --- API routes ---
  if (path.startsWith("/api/")) {
    // Status
    if (path === "/api/status" && method === "GET") {
      return json({
        status: "ok",
        vault: vault_dir,
        models: { llm: llm_model, embed: embed_model },
      });
    }

    // List all notes
    if (path === "/api/notes" && method === "GET") {
      return json({ notes: db.getAllNotes() });
    }

    // Get single note
    if (path.startsWith("/api/notes/") && method === "GET") {
      const id = parseInt(path.split("/")[3]);
      const note = db.getNote(id);
      if (!note) return json({ error: "Not found" }, 404);
      const content = await Deno.readTextFile(note.file_path);
      return json({ ...note, content });
    }

    // Ingest
    if (path === "/api/ingest" && method === "POST") {
      const body = await req.json();
      const { url: srcUrl, text, title } = body;

      let ingested;
      try {
        if (srcUrl) {
          ingested = await ingestYouTube(srcUrl);
        } else if (text) {
          ingested = await ingestText(title ?? "Untitled", text);
        } else {
          return json({ error: "Provide 'url' or 'text'" }, 400);
        }
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }

      // Distil
      let distilled;
      try {
        distilled = await distil(
          ingested.transcript,
          ingested.title,
          ingested.sourceUrl,
          api_base,
          api_key,
          llm_model,
        );
      } catch (err) {
        return json({ error: `Distillation failed: ${errMsg(err)}` }, 500);
      }

      // Save notes + embed
      const savedNotes: Array<{ id: number; title: string }> = [];
      for (const note of distilled.notes) {
        const safeTitle = sanitizeTitle(note.title);
        const filePath = `${vault_dir}/notes/${safeTitle}.md`;
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
          console.log(`Embedding note ${noteId}: ${note.title}`);
          await embedAndStore(
            noteId,
            note.title,
            note.body,
            db,
            api_base,
            api_key,
            embed_model,
          );
          console.log(`Embedded note ${noteId}`);
        } catch (err) {
          console.error(`Embedding failed for note ${noteId}: ${errMsg(err)}`);
        }

        savedNotes.push({ id: noteId, title: note.title });
      }

      // Recompute links
      try {
        await computeLinks(db);
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
            api_base,
            api_key,
            llm_model,
          );

          for (const note of distilled.notes) {
            const safeTitle = sanitizeTitle(note.title);
            const filePath = `${vault_dir}/notes/${safeTitle}.md`;
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
                api_base,
                api_key,
                embed_model,
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
        await computeLinks(db);
      } catch (err) {
        console.error(`Link computation failed: ${errMsg(err)}`);
      }

      return json({ videos: videoUrls.length, notes: allNotes, errors });
    }

    // Search
    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q) return json({ results: [], query: "" });
      try {
        const results = await search(q, db, api_base, api_key, embed_model);
        return json({ results, query: q });
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }
    }

    // Graph
    if (path === "/api/graph" && method === "GET") {
      const notes = db.getAllNotes();
      const links = db.getLinks();
      return json({
        nodes: notes.map((n) => ({ id: n.id, title: n.title })),
        links: links.map((l) => ({ source: l.source, target: l.target })),
      });
    }

    return json({ error: "Not found" }, 404);
  }

  // --- Static files ---
  return serveStatic(path);
});

// --- Helpers ---

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
