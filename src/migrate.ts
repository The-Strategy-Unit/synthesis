import { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";
import { config } from "./config.ts";

const OLD_DB = Deno.args[0] ?? "./output/synthesis.db";
const NEW_DB = Deno.args[1] ?? `${config.vaultDir}/synthesis.db`;
const NOTES_DIR = `${config.vaultDir}/notes`;
const SOURCES_DIR = `${config.vaultDir}/sources`;

// --- Open old DB with sqlite-vec to read vec0 embeddings ---

const oldDb = new DatabaseSync(OLD_DB, {
  readOnly: true,
  allowExtension: true,
});
load(oldDb);

// --- Open new DB with sqlite-vec ---

await Deno.mkdir(NOTES_DIR, { recursive: true });
await Deno.mkdir(SOURCES_DIR, { recursive: true });

const newDb = new DatabaseSync(NEW_DB, { allowExtension: true });
load(newDb);
newDb.exec("PRAGMA journal_mode = WAL");

newDb.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    source_url TEXT,
    source_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS links (
    source_note_id INTEGER NOT NULL,
    target_note_id INTEGER NOT NULL,
    similarity REAL NOT NULL,
    UNIQUE(source_note_id, target_note_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    note_id INTEGER PRIMARY KEY,
    vector FLOAT[4096] distance_metric=cosine
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content);
`);

// --- Migrate zettels → notes + markdown files ---

const zettels = oldDb.prepare(
  `SELECT z.id, z.insight, z.tags, z.question, z.created_at,
          e.title as ep_title, e.url as ep_url, e.video_id
   FROM zettels z JOIN episodes e ON z.episode_id = e.id`,
).all() as Array<{
  id: number;
  insight: string;
  tags: string;
  question: string;
  created_at: string;
  ep_title: string;
  ep_url: string;
  video_id: string;
}>;

console.log(`Migrating ${zettels.length} zettels...`);

const sourceMap = new Map<
  string,
  { url: string; title: string; noteIds: number[] }
>();

const insertNote = newDb.prepare(
  "INSERT OR REPLACE INTO notes (id, title, file_path, source_url, source_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);

const insertFts = newDb.prepare(
  "INSERT OR REPLACE INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)",
);

for (const z of zettels) {
  // insight field: first line is title, rest is body
  const lines = z.insight.split("\n");
  const title = lines[0].trim();
  const body = lines.slice(1).join("\n").trim();
  const slug = sanitize(title);
  const filePath = `${NOTES_DIR}/${slug}.md`;

  // Write markdown with frontmatter
  const md = [
    "---",
    `source: "${z.ep_title}"`,
    `url: "${z.ep_url}"`,
    z.question ? `question: "${z.question}"` : null,
    `tags: [${
      (z.tags ?? "").split(",").map((t) => `"${t.trim()}"`).join(", ")
    }]`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].filter((l) => l !== null).join("\n");

  await Deno.writeTextFile(filePath, md);

  insertNote.run(z.id, title, filePath, z.ep_url, "youtube", z.created_at);
  insertFts.run(Number(z.id), title, body);

  // Track sources
  if (!sourceMap.has(z.ep_title)) {
    sourceMap.set(z.ep_title, {
      url: z.ep_url,
      title: z.ep_title,
      noteIds: [],
    });
  }
  sourceMap.get(z.ep_title)!.noteIds.push(z.id);
}

// --- Write source metadata ---

for (const [epTitle, meta] of sourceMap) {
  const sourceSlug = sanitize(epTitle);
  const dir = `${SOURCES_DIR}/${sourceSlug}`;
  await Deno.mkdir(dir, { recursive: true });

  await Deno.writeTextFile(
    `${dir}/meta.json`,
    JSON.stringify(
      {
        title: epTitle,
        url: meta.url,
        noteIds: meta.noteIds,
        noteCount: meta.noteIds.length,
      },
      null,
      2,
    ),
  );
}

// --- Migrate links (deduplicate bidirectional pairs) ---

const links = oldDb.prepare(
  "SELECT zettel_id, related_zettel_id, strength FROM zettel_links",
).all() as Array<
  { zettel_id: number; related_zettel_id: number; strength: number }
>;

const seenLinks = new Set<string>();
const insertLink = newDb.prepare(
  "INSERT OR IGNORE INTO links (source_note_id, target_note_id, similarity) VALUES (?, ?, ?)",
);

let linkCount = 0;
for (const l of links) {
  const key = `${Math.min(l.zettel_id, l.related_zettel_id)}-${
    Math.max(l.zettel_id, l.related_zettel_id)
  }`;
  if (seenLinks.has(key)) continue;
  seenLinks.add(key);
  insertLink.run(l.zettel_id, l.related_zettel_id, l.strength);
  linkCount++;
}

console.log(`Migrated ${linkCount} unique links.`);

// --- Migrate embeddings (vec0 → vec0) ---

const embeddings = oldDb.prepare(
  "SELECT zettel_id, vector FROM embeddings",
).all() as Array<{ zettel_id: number; vector: Uint8Array }>;

const insertEmb = newDb.prepare(
  "INSERT OR REPLACE INTO embeddings (note_id, vector) VALUES (CAST(? AS INTEGER), ?)",
);

let embCount = 0;
for (const e of embeddings) {
  insertEmb.run(parseInt(String(e.zettel_id)), e.vector);
  embCount++;
}

console.log(`Migrated ${embCount} embeddings.`);
console.log("Done!");

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
