// Ingest orchestration: turns a fetched source (transcript/text) into notes.
//
// Runs the distil -> integrate pipeline, then for each resulting note either
// writes a new note file or rewrites an existing one (merge/contradict),
// indexing and embedding as it goes.

import { dirname } from "node:path";

import { notesDir, sourcesDir } from "./config.ts";
import { errMsg, slugify } from "./utils.ts";
import { DB } from "./db.ts";
import { distil, type DistilNote, integrate, rewriteNote } from "./distil.ts";
import {
  type ActiveProviders,
  environmentProviders,
} from "./provider_runtime.ts";
import { renderWikiPage, validateWikiPage, type WikiChange } from "./wiki.ts";
import { updateWikiCatalog } from "./wiki_store.ts";

export function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s.trim());
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createOrReadFile(
  filePath: string,
  content: string,
): Promise<string> {
  try {
    await Deno.writeTextFile(filePath, content, { createNew: true });
    return content;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    return await Deno.readTextFile(filePath);
  }
}

function sourceReference(
  title: string,
  sourceUrl: string,
  contentHash: string,
): string {
  const safeTitle = title.replace(/\s+/g, " ").trim();
  const safeUrl = sourceUrl.replaceAll("<", "%3C").replaceAll(">", "%3E");
  const location = safeUrl ? `; URL: <${safeUrl}>` : "; pasted text";
  return `- Source: ${safeTitle}${location}; SHA-256: \`${contentHash}\` <!-- synthesis-source:${contentHash} -->`;
}

function addSourceReferences(markdown: string, references: string[]): string {
  const marker = /<!-- synthesis-source:[a-f0-9]{64} -->/;
  const byHash = new Map<string, string>();
  for (const reference of references) {
    const hash = reference.match(/synthesis-source:([a-f0-9]{64})/)?.[1];
    if (hash) byHash.set(hash, reference);
  }

  const withoutManagedReferences = markdown.split("\n")
    .filter((line) => !marker.test(line))
    .join("\n")
    .trimEnd();
  const lines = [...byHash.values()].join("\n");
  if (/^## Sources\s*$/m.test(withoutManagedReferences)) {
    return `${withoutManagedReferences}\n\n${lines}\n`;
  }
  return `${withoutManagedReferences}\n\n## Sources\n\n${lines}\n`;
}

function existingSourceReferences(markdown: string): string[] {
  return markdown.split("\n").filter((line) =>
    /<!-- synthesis-source:[a-f0-9]{64} -->/.test(line)
  );
}

function normalizedTitle(title: string): string {
  return title.toLocaleLowerCase("en-US");
}

function resolvePageLinks(
  note: DistilNote,
  canonicalTitles: ReadonlyMap<string, string>,
): DistilNote {
  return validateWikiPage({
    ...note,
    links: note.links.map((link) =>
      canonicalTitles.get(normalizedTitle(link)) ?? link
    ),
  });
}

async function persistSourceFiles(
  contentHash: string,
  ingested: { transcript: string; sourceUrl: string; title: string },
  sourceType: string,
  summary: string,
): Promise<{ rawPath: string; summary: string }> {
  const directory = `${sourcesDir()}/${contentHash}`;
  await Deno.mkdir(directory, { recursive: true });

  const rawPath = `${directory}/source.txt`;
  const storedRaw = await createOrReadFile(rawPath, ingested.transcript);
  if (storedRaw !== ingested.transcript) {
    throw new Error(
      `Stored source content does not match SHA-256 ${contentHash}`,
    );
  }

  const metadata = JSON.stringify(
    {
      contentHash,
      title: ingested.title,
      sourceUrl: ingested.sourceUrl,
      sourceType,
    },
    null,
    2,
  ) + "\n";
  const storedMetadata = await createOrReadFile(
    `${directory}/meta.json`,
    metadata,
  );
  try {
    const parsed = JSON.parse(storedMetadata) as Record<string, unknown>;
    if (parsed.contentHash !== contentHash) {
      throw new Error("content hash does not match directory");
    }
  } catch (error) {
    throw new Error(
      `Invalid source metadata for ${contentHash}: ${errMsg(error)}`,
    );
  }

  const storedSummary = await createOrReadFile(
    `${directory}/summary.md`,
    summary.trim() + "\n",
  );
  return { rawPath, summary: storedSummary.trim() };
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  const tempPath = await Deno.makeTempFile({
    dir: dirname(filePath),
    prefix: ".synthesis-",
    suffix: ".tmp",
  });
  try {
    await Deno.writeTextFile(tempPath, content);
    await Deno.rename(tempPath, filePath);
  } catch (error) {
    try {
      await Deno.remove(tempPath);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) {
        console.error(`Temporary file cleanup failed: ${errMsg(cleanupError)}`);
      }
    }
    throw error;
  }
}

async function createNoteFile(
  db: DB,
  title: string,
  content: string,
): Promise<string> {
  const base = slugify(title) || "untitled";
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const name = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const filePath = `${notesDir()}/${name}.md`;
    if (db.getNoteByFilePath(filePath)) continue;
    try {
      await Deno.writeTextFile(filePath, content, { createNew: true });
      return filePath;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique filename for note: ${title}`);
}

export async function processSingleSource(
  db: DB,
  ingested: { transcript: string; sourceUrl: string; title: string },
  isText: boolean,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders = environmentProviders(),
): Promise<{
  notes: Array<{ id: number; title: string }>;
  newCount: number;
  mergeCount: number;
  contradictCount: number;
  touchedIds: number[];
}> {
  const contentHash = await sha256(ingested.transcript);
  const knownSource = db.getSourceByHash(contentHash);
  if (knownSource) {
    const persisted = await persistSourceFiles(
      contentHash,
      ingested,
      knownSource.source_type,
      knownSource.summary,
    );
    if (persisted.rawPath !== knownSource.file_path) {
      throw new Error(`Source ${contentHash} has a conflicting file path`);
    }
    const knownNotes = db.getNotesForSource(knownSource.id);
    if (knownNotes.length > 0) {
      send("source_exists", {
        title: knownSource.title,
        noteCount: knownNotes.length,
      });
      return {
        notes: knownNotes.map((note) => ({ id: note.id, title: note.title })),
        newCount: 0,
        mergeCount: 0,
        contradictCount: 0,
        touchedIds: [],
      };
    }
  }

  send("extracting");
  const distilled = await distil(
    ingested.transcript,
    providers.llm.apiBase,
    providers.llm.apiKey,
  );
  send("distilled", { noteCount: distilled.notes.length });

  const sourceType = isText ? "text" : "youtube";
  const persistedSource = await persistSourceFiles(
    contentHash,
    ingested,
    sourceType,
    distilled.summary,
  );
  const sourceId = db.withTransaction(() => {
    const existing = db.getSourceByHash(contentHash);
    if (existing) {
      if (existing.file_path !== persistedSource.rawPath) {
        throw new Error(`Source ${contentHash} has a conflicting file path`);
      }
      return existing.id;
    }
    return db.addSource(
      contentHash,
      ingested.title,
      ingested.sourceUrl || null,
      sourceType,
      persistedSource.rawPath,
      persistedSource.summary,
    );
  });
  const currentSourceReference = sourceReference(
    ingested.title,
    ingested.sourceUrl,
    contentHash,
  );

  const existingById = new Map<
    number,
    { id: number; title: string; body: string }
  >();
  for (const note of distilled.notes) {
    for (
      const candidate of db.findIntegrationCandidates(
        `${note.title}\n${note.body}`,
        5,
      )
    ) {
      if (existingById.size >= 24) break;
      existingById.set(candidate.id, candidate);
    }
  }
  const existingNotes = [...existingById.values()];
  const decisions = await integrate(
    distilled.notes,
    existingNotes,
    providers.llm.apiBase,
    providers.llm.apiKey,
    providers.llm.integrateModel,
  );
  const canonicalTitles = new Map<string, string>();
  for (let index = 0; index < distilled.notes.length; index++) {
    const note = distilled.notes[index];
    const decision = decisions[index];
    const canonicalTitle = decision.action === "new"
      ? note.title
      : existingById.get(decision.existing_id!)!.title;
    canonicalTitles.set(normalizedTitle(note.title), canonicalTitle);
  }
  const resolvedNotes = distilled.notes.map((note) =>
    resolvePageLinks(note, canonicalTitles)
  );

  send("embedding");
  const allNotes: Array<{ id: number; title: string }> = [];
  const touchedIds: number[] = [];
  let newCount = 0;
  let mergeCount = 0;
  let contradictCount = 0;

  for (let i = 0; i < resolvedNotes.length; i++) {
    const note = resolvedNotes[i];
    const decision = decisions[i];

    if (
      decision.action === "merge" ||
      decision.action === "contradict"
    ) {
      const existing = db.getNote(decision.existing_id!);
      if (!existing) {
        throw new Error(
          `Integration target note ${decision.existing_id} does not exist`,
        );
      }

      const existingContent = await Deno.readTextFile(existing.file_path);
      const rewrittenContent = await rewriteNote(
        existingContent,
        note,
        decision.action,
        providers.llm.apiBase,
        providers.llm.apiKey,
        providers.llm.rewriteModel,
      );
      const updatedContent = addSourceReferences(rewrittenContent, [
        ...existingSourceReferences(existingContent),
        currentSourceReference,
      ]);
      const embedding = await DB.embedText(
        `${existing.title}\n${updatedContent}`,
        providers.embedding.apiBase,
        providers.embedding.apiKey,
        providers.embedding.model,
      );

      await replaceFile(existing.file_path, updatedContent);
      try {
        db.withTransaction(() => {
          db.indexNote(existing.id, existing.title, updatedContent);
          db.upsertEmbedding(existing.id, embedding);
          db.attachNoteSource(existing.id, sourceId, decision.action);
        });
      } catch (error) {
        try {
          await replaceFile(existing.file_path, existingContent);
        } catch (restoreError) {
          throw new Error(
            `Database update failed and note restoration failed: ${
              errMsg(restoreError)
            }`,
            { cause: error },
          );
        }
        throw error;
      }

      allNotes.push({ id: existing.id, title: existing.title });
      touchedIds.push(existing.id);
      if (decision.action === "merge") mergeCount++;
      else contradictCount++;
      continue;
    }

    const md = renderWikiPage(note, [{
      title: ingested.title,
      url: ingested.sourceUrl || undefined,
      contentHash,
    }]);
    const embedding = await DB.embedText(
      `${note.title}\n${note.body}`,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
    );
    const filePath = await createNoteFile(db, note.title, md);
    let noteId: number;
    try {
      noteId = db.withTransaction(() => {
        const id = db.addNote(
          note.title,
          filePath,
          ingested.sourceUrl,
          sourceType,
        );
        db.indexNote(id, note.title, note.body);
        db.upsertEmbedding(id, embedding);
        db.attachNoteSource(id, sourceId, "new");
        return id;
      });
    } catch (error) {
      try {
        await Deno.remove(filePath);
      } catch (cleanupError) {
        throw new Error(
          `Database insert failed and new note cleanup failed: ${
            errMsg(cleanupError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
    allNotes.push({ id: noteId, title: note.title });
    touchedIds.push(noteId);
    newCount++;
  }

  const changes: WikiChange[] = decisions.map((decision, index) => ({
    action: decision.action === "new"
      ? "create"
      : decision.action === "merge"
      ? "update"
      : "contradict",
    pageTitle: canonicalTitles.get(
      normalizedTitle(distilled.notes[index].title),
    )!,
    pageType: distilled.notes[index].type,
  }));
  await updateWikiCatalog(db, {
    operation: "ingest",
    subject: ingested.title,
    contentHash,
    changes,
  });

  return {
    notes: allNotes,
    newCount,
    mergeCount,
    contradictCount,
    touchedIds: [...new Set(touchedIds)],
  };
}
