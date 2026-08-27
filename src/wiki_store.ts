import { dirname } from "node:path";

import { notesDir } from "./config.ts";
import { DB } from "./db.ts";
import { type ActiveProviders, embeddingIdentity } from "./provider_runtime.ts";
import { slugify } from "./utils.ts";
import {
  parseWikiPage,
  renderWikiIndex,
  renderWikiLogEntry,
  renderWikiPage,
  validateWikiPage,
  type WikiChange,
  type WikiIndexEntry,
  type WikiLogEntry,
  type WikiPage,
} from "./wiki.ts";

export class WikiPageExistsError extends Error {
  constructor(readonly noteId: number, title: string) {
    super(`A wiki page named "${title}" already exists`);
    this.name = "WikiPageExistsError";
  }
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await Deno.mkdir(dirname(filePath), { recursive: true });
  try {
    await Deno.writeTextFile(tempPath, content, { createNew: true });
    await Deno.rename(tempPath, filePath);
  } catch (error) {
    try {
      await Deno.remove(tempPath);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
    }
    throw error;
  }
}

function legacyIndexSummary(markdown: string): string {
  const withoutFrontmatter = markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
    .replace(/^# .*\n+/, "");
  const paragraphs = withoutFrontmatter
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("## Sources"));
  return paragraphs[0] ?? "Legacy wiki page.";
}

async function wikiIndexEntries(db: DB): Promise<WikiIndexEntry[]> {
  const entries: WikiIndexEntry[] = [];
  for (const note of db.getAllNotes()) {
    const markdown = await Deno.readTextFile(note.file_path);
    try {
      const page = parseWikiPage(markdown);
      entries.push({
        title: page.title,
        type: page.type,
        summary: page.body.split(/\n\s*\n/, 1)[0],
      });
    } catch {
      entries.push({
        title: note.title,
        type: "concept",
        summary: legacyIndexSummary(markdown),
      });
    }
  }
  return entries;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function rebuildWikiIndex(db: DB): Promise<void> {
  await replaceFile(
    `${notesDir()}/index.md`,
    renderWikiIndex(await wikiIndexEntries(db)),
  );
}

export async function appendWikiLog(
  entry: Omit<WikiLogEntry, "timestamp">,
): Promise<void> {
  const logPath = `${notesDir()}/log.md`;
  const existingLog = await readIfPresent(logPath);
  const rendered = renderWikiLogEntry({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  const log = existingLog
    ? `${existingLog.trimEnd()}\n\n${rendered}`
    : `# Synthesis Wiki Log\n\n${rendered}`;
  await replaceFile(logPath, log);
}

export async function updateWikiCatalog(
  db: DB,
  entry: {
    operation: WikiLogEntry["operation"];
    subject: string;
    contentHash?: string;
    changes: WikiChange[];
  },
): Promise<void> {
  await rebuildWikiIndex(db);
  await appendWikiLog(entry);
}

async function createPageFile(
  db: DB,
  title: string,
  markdown: string,
): Promise<string> {
  const base = slugify(title) || "wiki-page";
  for (let suffix = 1; suffix <= 1_000; suffix++) {
    const filename = suffix === 1 ? `${base}.md` : `${base}-${suffix}.md`;
    const filePath = `${notesDir()}/${filename}`;
    if (db.getNoteByFilePath(filePath)) continue;
    try {
      await Deno.writeTextFile(filePath, markdown, { createNew: true });
      return filePath;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  throw new Error(`Could not allocate a unique filename for page: ${title}`);
}

export async function saveWikiSynthesis(
  db: DB,
  pageValue: WikiPage,
  citedNoteIds: number[],
  providers: ActiveProviders,
  question: string,
): Promise<{ id: number; title: string }> {
  const page = validateWikiPage(pageValue);
  if (page.type !== "synthesis") {
    throw new Error("Only synthesis pages can be saved from a wiki query");
  }
  const existing = db.getNoteByExactTitle(page.title);
  if (existing) throw new WikiPageExistsError(existing.id, page.title);

  const citedNotes = citedNoteIds.map((id) => {
    const note = db.getNote(id);
    if (!note) throw new Error(`Cited wiki page ${id} does not exist`);
    return note;
  });
  const citedTitles = new Set(
    citedNotes.map((note) => note.title.toLocaleLowerCase("en-GB")),
  );
  const linkedTitles = new Set(
    page.links.map((title) => title.toLocaleLowerCase("en-GB")),
  );
  if (
    citedTitles.size !== linkedTitles.size ||
    [...citedTitles].some((title) => !linkedTitles.has(title))
  ) {
    throw new Error("Synthesis page links must match its cited wiki pages");
  }

  const sources = db.getSourcesForNotes(citedNoteIds);
  if (sources.length === 0) {
    throw new Error("Cited wiki pages have no immutable source provenance");
  }
  const markdown = renderWikiPage(
    page,
    sources.map((source) => ({
      title: source.title,
      url: source.source_url || undefined,
      contentHash: source.content_hash,
    })),
  );
  db.activateSemanticIndex(embeddingIdentity(providers.embedding));
  const embedding = await DB.embedText(
    `${page.title}\n${page.body}`,
    providers.embedding.apiBase,
    providers.embedding.apiKey,
    providers.embedding.model,
    "document",
  );
  const filePath = await createPageFile(db, page.title, markdown);
  let noteId: number;
  try {
    noteId = db.withTransaction(() => {
      const id = db.addNote(page.title, filePath, null, "query");
      db.indexNote(id, page.title, page.body);
      db.upsertEmbedding(id, embedding);
      for (const source of sources) db.attachNoteSource(id, source.id, "query");
      return id;
    });
  } catch (error) {
    await Deno.remove(filePath);
    throw error;
  }

  if (db.semanticIndexStatus().complete) db.computeLinksFor([noteId]);
  else db.clearLinks();
  await updateWikiCatalog(db, {
    operation: "query",
    subject: question,
    changes: [{
      action: "create",
      pageTitle: page.title,
      pageType: "synthesis",
    }],
  });
  return { id: noteId, title: page.title };
}
