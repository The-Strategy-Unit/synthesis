// Ingest orchestration: turns a fetched source (transcript/text) into notes.
//
// Runs the distil -> integrate pipeline, then for each resulting note either
// writes a new note file or rewrites an existing one (merge/contradict),
// indexing and embedding as it goes.

import { dirname } from "node:path";

import { notesDir, sourcesDir } from "./config.ts";
import { errMsg, slugify } from "./utils.ts";
import { DB, type IngestProposalRecord } from "./db.ts";
import { distil, type DistilNote, integrate, rewriteNote } from "./distil.ts";
import type { IngestResult, SourceType } from "./ingest.ts";
import {
  type IngestProposalApproval,
  type IngestProposalApprovalChange,
  type IngestProposalChange,
  parseStoredIngestProposal,
  serializeIngestProposal,
  validateIngestProposalApproval,
} from "./ingest_proposal.ts";
import {
  type IngestReviewAudit,
  removeWrittenIngestHistory,
  writeIngestHistory,
  type WrittenIngestHistory,
} from "./ingest_history.ts";
import {
  type ActiveProviders,
  environmentProviders,
} from "./provider_runtime.ts";
import {
  findSourceReferencePages,
  parseWikiPage,
  renderWikiPage,
  type SourceReference,
  validateWikiPage,
  type WikiChange,
  type WikiPage,
} from "./wiki.ts";
import { ensureWikiSchema } from "./wiki_schema.ts";
import { updateWikiCatalog } from "./wiki_store.ts";

export function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s.trim());
}

type IngestSource = Omit<IngestResult, "sourceType"> & {
  sourceType?: SourceType;
};

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(text: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(text));
}

async function sourceHash(ingested: IngestSource): Promise<string> {
  return ingested.originalFile
    ? await sha256Bytes(ingested.originalFile.bytes)
    : await sha256(ingested.transcript);
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

async function createOrReadBytes(
  filePath: string,
  content: Uint8Array,
): Promise<Uint8Array> {
  try {
    await Deno.writeFile(filePath, content, { createNew: true });
    return content;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    return await Deno.readFile(filePath);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function normalizedTitle(title: string): string {
  return title.toLocaleLowerCase("en-US");
}

function sourceReferencesForRewrite(
  db: DB,
  noteId: number,
  markdown: string,
  current: SourceReference,
): SourceReference[] {
  const references = new Map<string, SourceReference>();
  const add = (source: SourceReference) => {
    const existing = references.get(source.contentHash);
    const pages = [
      ...new Set([
        ...(existing?.pages ?? []),
        ...(source.pages ?? []),
      ]),
    ].sort((left, right) => left - right);
    references.set(source.contentHash, {
      ...(existing ?? source),
      ...(pages.length > 0 ? { pages } : {}),
    });
  };

  for (const source of db.getSourceProvenanceForNote(noteId)) {
    add({
      title: source.title,
      url: source.source_url || undefined,
      contentHash: source.content_hash,
      pages: findSourceReferencePages(markdown, source.content_hash),
    });
  }
  const currentPages = [
    ...new Set([
      ...(findSourceReferencePages(markdown, current.contentHash) ?? []),
      ...(current.pages ?? []),
    ]),
  ].sort((left, right) => left - right);
  add({
    ...current,
    ...(currentPages.length > 0 ? { pages: currentPages } : {}),
  });
  return [...references.values()];
}

function resolvePageLinks(
  note: DistilNote,
  canonicalTitles: ReadonlyMap<string, string>,
): DistilNote {
  const page = validateWikiPage({
    ...note,
    links: note.links.map((link) =>
      canonicalTitles.get(normalizedTitle(link)) ?? link
    ),
  });
  return {
    ...page,
    ...(note.sourcePages ? { sourcePages: note.sourcePages } : {}),
  };
}

function validateRewrittenPage(
  existingTitle: string,
  existingMarkdown: string,
  rewrittenMarkdown: string,
): WikiPage {
  const rewrittenPage = parseWikiPage(rewrittenMarkdown);
  if (rewrittenPage.title !== existingTitle) {
    throw new Error(
      `Rewritten wiki page title changed from "${existingTitle}" to "${rewrittenPage.title}"`,
    );
  }

  let existingPage: WikiPage | undefined;
  try {
    existingPage = parseWikiPage(existingMarkdown);
  } catch {
    // A validated rewrite may upgrade a legacy page into compiler-managed form.
  }
  if (existingPage && rewrittenPage.type !== existingPage.type) {
    throw new Error(
      `Rewritten wiki page type changed from "${existingPage.type}" to "${rewrittenPage.type}"`,
    );
  }
  return rewrittenPage;
}

interface ExistingWikiNote {
  id: number;
  title: string;
  file_path: string;
  source_url: string | null;
  source_type: string | null;
}

interface PreparedUpdate {
  existing: ExistingWikiNote;
  originalContent: string;
  content: string;
  page: WikiPage;
  action: "merge" | "contradict";
}

interface PreparedCreate {
  page: WikiPage;
  content: string;
}

interface EmbeddedUpdate extends PreparedUpdate {
  embedding: number[];
}

interface EmbeddedCreate extends PreparedCreate {
  embedding: number[];
}

interface AppliedCreate extends EmbeddedCreate {
  filePath: string;
  id?: number;
}

export interface AppliedIngestResult {
  notes: Array<{ id: number; title: string }>;
  newCount: number;
  mergeCount: number;
  contradictCount: number;
  touchedIds: number[];
  historyId?: string;
}

export interface IngestProposalReview {
  id: number;
  status: IngestProposalRecord["status"];
  createdAt: string;
  reviewedAt: string | null;
  source: {
    id: number;
    title: string;
    sourceUrl: string | null;
    sourceType: string;
    summary: string;
    contentHash: string;
  };
  changes: Array<{
    action: "new" | "merge" | "contradict";
    pageId?: number;
    page: WikiPage;
    markdown: string;
    sourcePages?: number[];
  }>;
}

export type StagedIngestResult =
  | { kind: "proposal"; proposal: IngestProposalReview }
  | { kind: "already-applied"; result: AppliedIngestResult };

export class IngestProposalNotFoundError extends Error {}
export class IngestProposalStateError extends Error {}
export class IngestProposalApprovalError extends Error {}
export class StaleIngestProposalError extends Error {}
export class InvalidWikiLinkError extends Error {}

function validateProposedWikiLinks(
  db: DB,
  updatedPages: Iterable<WikiPage>,
  createdPages: Iterable<WikiPage>,
): void {
  const titleCounts = new Map<string, number>();
  for (const note of db.getAllNotes()) {
    const key = normalizedTitle(note.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const creates = [...createdPages];
  for (const page of creates) {
    const key = normalizedTitle(page.title);
    if (titleCounts.has(key)) {
      throw new InvalidWikiLinkError(
        `Proposed page title "${page.title}" is already in use`,
      );
    }
    titleCounts.set(key, 1);
  }

  for (const page of [...updatedPages, ...creates]) {
    for (const link of page.links) {
      const matches = titleCounts.get(normalizedTitle(link)) ?? 0;
      if (matches !== 1) {
        throw new InvalidWikiLinkError(
          `Wiki link "${link}" on "${page.title}" has ${matches} targets; expected exactly one`,
        );
      }
    }
  }
}

interface PreparedSourceChanges {
  kind: "prepared";
  contentHash: string;
  sourceId: number;
  sourceType: string;
  preparedUpdates: PreparedUpdate[];
  preparedCreates: PreparedCreate[];
  changes: WikiChange[];
  newCount: number;
  mergeCount: number;
  contradictCount: number;
}

interface AlreadyAppliedSource {
  kind: "already-applied";
  result: AppliedIngestResult;
}

async function persistSourceFiles(
  contentHash: string,
  ingested: IngestSource,
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

  if (ingested.originalFile) {
    const extension = sourceType === "pdf"
      ? "pdf"
      : sourceType === "markdown"
      ? "md"
      : "txt";
    const storedOriginal = await createOrReadBytes(
      `${directory}/original.${extension}`,
      ingested.originalFile.bytes,
    );
    if (!equalBytes(storedOriginal, ingested.originalFile.bytes)) {
      throw new Error(
        `Stored original file does not match SHA-256 ${contentHash}`,
      );
    }
  }

  const metadata = JSON.stringify(
    {
      contentHash,
      title: ingested.title,
      sourceUrl: ingested.sourceUrl,
      sourceType,
      ...(ingested.originalFile
        ? {
          originalFileName: ingested.originalFile.fileName,
          mediaType: ingested.originalFile.mediaType,
        }
        : {}),
      ...(ingested.pageCount === undefined
        ? {}
        : { pageCount: ingested.pageCount }),
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

async function applyPreparedWikiChanges(
  db: DB,
  preparedUpdates: Iterable<PreparedUpdate>,
  preparedCreates: PreparedCreate[],
  sourceId: number,
  ingested: { sourceUrl: string; title: string },
  sourceType: string,
  contentHash: string,
  changes: WikiChange[],
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders,
  options?: {
    proposalId?: number;
    finalizeTransaction?: () => void;
    review?: IngestReviewAudit;
  },
): Promise<{
  notes: Array<{ id: number; title: string }>;
  touchedIds: number[];
  historyId?: string;
}> {
  send("embedding");
  const embeddedUpdates: EmbeddedUpdate[] = [];
  for (const update of preparedUpdates) {
    const embedding = await DB.embedText(
      `${update.existing.title}\n${update.page.body}`,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
    );
    embeddedUpdates.push({ ...update, embedding });
  }
  const embeddedCreates: EmbeddedCreate[] = [];
  for (const create of preparedCreates) {
    const embedding = await DB.embedText(
      `${create.page.title}\n${create.page.body}`,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
    );
    embeddedCreates.push({ ...create, embedding });
  }

  const appliedUpdates: EmbeddedUpdate[] = [];
  const createdFiles: AppliedCreate[] = [];
  let writtenHistory: WrittenIngestHistory | undefined;
  try {
    for (const update of embeddedUpdates) {
      await replaceFile(update.existing.file_path, update.content);
      appliedUpdates.push(update);
    }
    for (const create of embeddedCreates) {
      const filePath = await createNoteFile(
        db,
        create.page.title,
        create.content,
      );
      createdFiles.push({ ...create, filePath });
    }

    if (options?.proposalId !== undefined) {
      writtenHistory = await writeIngestHistory({
        proposalId: options.proposalId,
        sourceHash: contentHash,
        sourceTitle: ingested.title,
        review: options.review,
        changes: [
          ...embeddedUpdates.map((update) => ({
            action: update.action,
            pageTitle: update.page.title,
            filePath: update.existing.file_path,
            beforeContent: update.originalContent,
            afterContent: update.content,
          })),
          ...createdFiles.map((create) => ({
            action: "new" as const,
            pageTitle: create.page.title,
            filePath: create.filePath,
            afterContent: create.content,
          })),
        ],
      });
    }

    const createdIds = db.withTransaction(() => {
      for (const update of embeddedUpdates) {
        db.indexNote(
          update.existing.id,
          update.existing.title,
          update.page.body,
        );
        db.upsertEmbedding(update.existing.id, update.embedding);
        db.attachNoteSource(update.existing.id, sourceId, update.action);
      }
      const createdIds = createdFiles.map((create) => {
        const id = db.addNote(
          create.page.title,
          create.filePath,
          ingested.sourceUrl,
          sourceType,
        );
        db.indexNote(id, create.page.title, create.page.body);
        db.upsertEmbedding(id, create.embedding);
        db.attachNoteSource(id, sourceId, "new");
        return id;
      });
      options?.finalizeTransaction?.();
      return createdIds;
    });
    createdFiles.forEach((create, index) => {
      create.id = createdIds[index];
    });
  } catch (error) {
    const restorationErrors: string[] = [];
    if (writtenHistory) {
      try {
        await removeWrittenIngestHistory(writtenHistory);
      } catch (historyError) {
        restorationErrors.push(errMsg(historyError));
      }
    }
    for (const update of appliedUpdates.toReversed()) {
      try {
        await replaceFile(update.existing.file_path, update.originalContent);
      } catch (restoreError) {
        restorationErrors.push(errMsg(restoreError));
      }
    }
    for (const create of createdFiles.toReversed()) {
      try {
        await Deno.remove(create.filePath);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) {
          restorationErrors.push(errMsg(cleanupError));
        }
      }
    }
    if (restorationErrors.length > 0) {
      throw new Error(
        `Wiki update failed and file restoration failed: ${
          restorationErrors.join("; ")
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  const updatedNotes = embeddedUpdates.map((update) => ({
    id: update.existing.id,
    title: update.existing.title,
  }));
  const createdNotes = createdFiles.map((create) => {
    if (create.id === undefined) {
      throw new Error(`Created wiki page "${create.page.title}" has no ID`);
    }
    return { id: create.id, title: create.page.title };
  });
  const notes = [...updatedNotes, ...createdNotes];
  const touchedIds = notes.map((note) => note.id);

  await updateWikiCatalog(db, {
    operation: "ingest",
    subject: ingested.title,
    contentHash,
    changes,
  });

  return {
    notes,
    touchedIds: [...new Set(touchedIds)],
    ...(writtenHistory ? { historyId: writtenHistory.manifest.historyId } : {}),
  };
}

async function prepareSingleSourceChanges(
  db: DB,
  ingested: IngestSource,
  isText: boolean,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders = environmentProviders(),
): Promise<PreparedSourceChanges | AlreadyAppliedSource> {
  const contentHash = await sourceHash(ingested);
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
        kind: "already-applied",
        result: {
          notes: knownNotes.map((note) => ({
            id: note.id,
            title: note.title,
          })),
          newCount: 0,
          mergeCount: 0,
          contradictCount: 0,
          touchedIds: [],
        },
      };
    }
  }

  const schema = await ensureWikiSchema();
  const sourceType = ingested.sourceType ?? (isText ? "text" : "youtube");
  if (
    sourceType === "pdf" &&
    (!Number.isSafeInteger(ingested.pageCount) || ingested.pageCount! < 1)
  ) {
    throw new Error("PDF source page count is invalid");
  }
  send("extracting");
  const distilled = await distil(
    ingested.transcript,
    providers.llm.apiBase,
    providers.llm.apiKey,
    schema,
    sourceType === "pdf" ? ingested.pageCount : undefined,
  );
  send("distilled", { noteCount: distilled.notes.length });

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
  send("integrating", {
    noteCount: distilled.notes.length,
    candidateCount: existingNotes.length,
  });
  const decisions = await integrate(
    distilled.notes,
    existingNotes,
    providers.llm.apiBase,
    providers.llm.apiKey,
    providers.llm.integrateModel,
    schema,
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

  const preparedUpdates = new Map<number, PreparedUpdate>();
  const preparedCreates: PreparedCreate[] = [];
  const updateGroups = new Map<
    number,
    {
      existing: ExistingWikiNote;
      notes: DistilNote[];
      action: "merge" | "contradict";
    }
  >();

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
      const group = updateGroups.get(existing.id);
      if (group) {
        group.notes.push(note);
        if (decision.action === "contradict") group.action = "contradict";
      } else {
        updateGroups.set(existing.id, {
          existing,
          notes: [note],
          action: decision.action,
        });
      }
      continue;
    }

    const md = renderWikiPage(note, [{
      title: ingested.title,
      url: ingested.sourceUrl || undefined,
      contentHash,
      pages: note.sourcePages,
    }]);
    preparedCreates.push({ page: note, content: md });
  }

  const groups = [...updateGroups.values()];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    send("rewriting", {
      current: index + 1,
      total: groups.length,
      title: group.existing.title,
    });
    const existingContent = await Deno.readTextFile(group.existing.file_path);
    const existingPage = parseWikiPage(existingContent);
    const rewrittenPage = await rewriteNote(
      existingPage,
      group.notes,
      group.action,
      providers.llm.apiBase,
      providers.llm.apiKey,
      providers.llm.rewriteModel,
      schema,
    );
    const sourcePages = [
      ...new Set(group.notes.flatMap((note) => note.sourcePages ?? [])),
    ].sort((left, right) => left - right);
    const updatedContent = renderWikiPage(
      rewrittenPage,
      sourceReferencesForRewrite(
        db,
        group.existing.id,
        existingContent,
        {
          title: ingested.title,
          url: ingested.sourceUrl || undefined,
          contentHash,
          ...(sourcePages.length > 0 ? { pages: sourcePages } : {}),
        },
      ),
    );
    const updatedPage = validateRewrittenPage(
      group.existing.title,
      existingContent,
      updatedContent,
    );
    preparedUpdates.set(group.existing.id, {
      existing: group.existing,
      originalContent: existingContent,
      content: updatedContent,
      page: updatedPage,
      action: group.action,
    });
  }

  const newCount = preparedCreates.length;
  const mergeCount = groups.filter((group) => group.action === "merge").length;
  const contradictCount =
    groups.filter((group) => group.action === "contradict").length;
  const changes: WikiChange[] = [
    ...preparedUpdates.values().map((update): WikiChange => ({
      action: update.action === "contradict" ? "contradict" : "update",
      pageTitle: update.page.title,
      pageType: update.page.type,
    })),
    ...preparedCreates.map((create): WikiChange => ({
      action: "create",
      pageTitle: create.page.title,
      pageType: create.page.type,
    })),
  ];
  validateProposedWikiLinks(
    db,
    preparedUpdates.values().map((update) => update.page),
    preparedCreates.map((create) => create.page),
  );
  return {
    kind: "prepared",
    contentHash,
    sourceId,
    sourceType,
    preparedUpdates: [...preparedUpdates.values()],
    preparedCreates,
    changes,
    newCount,
    mergeCount,
    contradictCount,
  };
}

export async function processSingleSource(
  db: DB,
  ingested: IngestSource,
  isText: boolean,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders = environmentProviders(),
): Promise<AppliedIngestResult> {
  const prepared = await prepareSingleSourceChanges(
    db,
    ingested,
    isText,
    send,
    providers,
  );
  if (prepared.kind === "already-applied") return prepared.result;

  const applied = await applyPreparedWikiChanges(
    db,
    prepared.preparedUpdates,
    prepared.preparedCreates,
    prepared.sourceId,
    ingested,
    prepared.sourceType,
    prepared.contentHash,
    prepared.changes,
    send,
    providers,
  );
  return {
    ...applied,
    newCount: prepared.newCount,
    mergeCount: prepared.mergeCount,
    contradictCount: prepared.contradictCount,
  };
}

function proposalReview(
  db: DB,
  record: IngestProposalRecord,
): IngestProposalReview {
  const proposal = parseStoredIngestProposal(record.proposal_json);
  const source = db.getSource(record.source_id);
  if (!source) {
    throw new Error(`Ingest proposal ${record.id} has no source record`);
  }
  if (
    proposal.sourceId !== source.id ||
    proposal.contentHash !== source.content_hash
  ) {
    throw new Error(`Ingest proposal ${record.id} source identity is invalid`);
  }
  return {
    id: record.id,
    status: record.status,
    createdAt: record.created_at,
    reviewedAt: record.reviewed_at,
    source: {
      id: source.id,
      title: source.title,
      sourceUrl: source.source_url,
      sourceType: source.source_type,
      summary: source.summary,
      contentHash: source.content_hash,
    },
    changes: proposal.reviewedChanges.map((change) => {
      const sourcePages = findSourceReferencePages(
        change.markdown,
        source.content_hash,
      );
      return {
        action: change.action,
        ...(change.pageId === undefined ? {} : { pageId: change.pageId }),
        page: change.page,
        markdown: change.markdown,
        ...(sourcePages ? { sourcePages } : {}),
      };
    }),
  };
}

export function getIngestProposalReview(
  db: DB,
  id: number,
): IngestProposalReview {
  const record = db.getIngestProposal(id);
  if (!record) {
    throw new IngestProposalNotFoundError(`Ingest proposal ${id} not found`);
  }
  return proposalReview(db, record);
}

export function listIngestProposalReviews(
  db: DB,
  status?: IngestProposalRecord["status"],
): IngestProposalReview[] {
  return db.getIngestProposals(status).map((record) =>
    proposalReview(db, record)
  );
}

export async function stageSingleSource(
  db: DB,
  ingested: IngestSource,
  isText: boolean,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders = environmentProviders(),
): Promise<StagedIngestResult> {
  const hash = await sourceHash(ingested);
  const knownSource = db.getSourceByHash(hash);
  if (knownSource) {
    const knownProposal = db.getIngestProposalForSource(knownSource.id);
    if (knownProposal) {
      const persisted = await persistSourceFiles(
        hash,
        ingested,
        knownSource.source_type,
        knownSource.summary,
      );
      if (persisted.rawPath !== knownSource.file_path) {
        throw new Error(`Source ${hash} has a conflicting file path`);
      }
      return { kind: "proposal", proposal: proposalReview(db, knownProposal) };
    }
  }

  const prepared = await prepareSingleSourceChanges(
    db,
    ingested,
    isText,
    send,
    providers,
  );
  if (prepared.kind === "already-applied") {
    return { kind: "already-applied", result: prepared.result };
  }

  const proposalChanges: IngestProposalChange[] = [];
  for (const update of prepared.preparedUpdates) {
    proposalChanges.push({
      action: update.action,
      pageId: update.existing.id,
      baseContentHash: await sha256(update.originalContent),
      markdown: update.content,
    });
  }
  for (const create of prepared.preparedCreates) {
    proposalChanges.push({ action: "new", markdown: create.content });
  }
  const proposalJson = serializeIngestProposal({
    version: 1,
    sourceId: prepared.sourceId,
    contentHash: prepared.contentHash,
    changes: proposalChanges,
  });
  const proposalId = db.addIngestProposal(prepared.sourceId, proposalJson);
  return {
    kind: "proposal",
    proposal: getIngestProposalReview(db, proposalId),
  };
}

export async function approveIngestProposal(
  db: DB,
  id: number,
  send: (stage: string, data?: unknown) => void,
  providers: ActiveProviders = environmentProviders(),
  approvalValue: IngestProposalApproval = {},
  review: IngestReviewAudit = { reviewMode: "manual" },
): Promise<AppliedIngestResult> {
  const record = db.getIngestProposal(id);
  if (!record) {
    throw new IngestProposalNotFoundError(`Ingest proposal ${id} not found`);
  }
  if (record.status !== "pending") {
    throw new IngestProposalStateError(
      `Ingest proposal ${id} is already ${record.status}`,
    );
  }
  const proposal = parseStoredIngestProposal(record.proposal_json);
  const source = db.getSource(record.source_id);
  if (
    !source || proposal.sourceId !== source.id ||
    proposal.contentHash !== source.content_hash
  ) {
    throw new Error(`Ingest proposal ${id} source identity is invalid`);
  }

  let approval: IngestProposalApproval;
  try {
    approval = validateIngestProposalApproval(approvalValue);
  } catch (error) {
    throw new IngestProposalApprovalError(errMsg(error));
  }
  const requestedChanges: IngestProposalApprovalChange[] = approval.changes ??
    proposal.reviewedChanges.map((_change, index) => ({ index }));
  const selectedIndexes = new Set(
    requestedChanges.map((requested) => requested.index),
  );
  const excludedNewTitles = new Set(
    proposal.reviewedChanges.flatMap((change, index) =>
      change.action === "new" && !selectedIndexes.has(index)
        ? [normalizedTitle(change.page.title)]
        : []
    ),
  );
  const selectedChanges = requestedChanges.map((requested) => {
    const change = proposal.reviewedChanges[requested.index];
    if (!change) {
      throw new IngestProposalApprovalError(
        `Ingest proposal approval index ${requested.index} is out of range`,
      );
    }

    try {
      const page = validateWikiPage({
        ...change.page,
        body: requested.body ?? change.page.body,
        links: change.page.links.filter((link) =>
          !excludedNewTitles.has(normalizedTitle(link))
        ),
      });
      const sourcePages = findSourceReferencePages(
        change.markdown,
        source.content_hash,
      );
      const currentSource: SourceReference = {
        title: source.title,
        url: source.source_url || undefined,
        contentHash: source.content_hash,
        ...(sourcePages ? { pages: sourcePages } : {}),
      };
      const references = change.action === "new"
        ? [currentSource]
        : sourceReferencesForRewrite(
          db,
          change.pageId!,
          change.markdown,
          currentSource,
        );
      return {
        ...change,
        page,
        markdown: renderWikiPage(page, references),
      };
    } catch (error) {
      throw new IngestProposalApprovalError(
        `Ingest proposal change ${requested.index + 1} is invalid: ${
          errMsg(error)
        }`,
      );
    }
  });

  const preparedUpdates: PreparedUpdate[] = [];
  const preparedCreates: PreparedCreate[] = [];
  const changes: WikiChange[] = [];
  for (const change of selectedChanges) {
    if (change.action === "new") {
      if (db.getNoteByExactTitle(change.page.title)) {
        throw new StaleIngestProposalError(
          `A wiki page titled "${change.page.title}" now exists`,
        );
      }
      preparedCreates.push({ page: change.page, content: change.markdown });
      changes.push({
        action: "create",
        pageTitle: change.page.title,
        pageType: change.page.type,
      });
      continue;
    }

    const existing = db.getNote(change.pageId!);
    if (!existing) {
      throw new StaleIngestProposalError(
        `Target wiki page ${change.pageId} no longer exists`,
      );
    }
    const currentContent = await Deno.readTextFile(existing.file_path);
    if (await sha256(currentContent) !== change.baseContentHash) {
      throw new StaleIngestProposalError(
        `Wiki page "${existing.title}" changed after this proposal was created`,
      );
    }
    const page = validateRewrittenPage(
      existing.title,
      currentContent,
      change.markdown,
    );
    preparedUpdates.push({
      existing,
      originalContent: currentContent,
      content: change.markdown,
      page,
      action: change.action,
    });
    changes.push({
      action: change.action === "contradict" ? "contradict" : "update",
      pageTitle: page.title,
      pageType: page.type,
    });
  }

  validateProposedWikiLinks(
    db,
    preparedUpdates.map((update) => update.page),
    preparedCreates.map((create) => create.page),
  );

  const applied = await applyPreparedWikiChanges(
    db,
    preparedUpdates,
    preparedCreates,
    source.id,
    { title: source.title, sourceUrl: source.source_url ?? "" },
    source.source_type,
    source.content_hash,
    changes,
    send,
    providers,
    {
      proposalId: id,
      review,
      finalizeTransaction: () => {
        if (!db.reviewIngestProposal(id, "approved")) {
          throw new IngestProposalStateError(
            `Ingest proposal ${id} is no longer pending`,
          );
        }
      },
    },
  );
  return {
    ...applied,
    newCount: preparedCreates.length,
    mergeCount: preparedUpdates.filter((change) => change.action === "merge")
      .length,
    contradictCount:
      preparedUpdates.filter((change) => change.action === "contradict").length,
  };
}

export function rejectIngestProposal(
  db: DB,
  id: number,
): IngestProposalReview {
  const record = db.getIngestProposal(id);
  if (!record) {
    throw new IngestProposalNotFoundError(`Ingest proposal ${id} not found`);
  }
  if (!db.reviewIngestProposal(id, "rejected")) {
    throw new IngestProposalStateError(
      `Ingest proposal ${id} is already ${record.status}`,
    );
  }
  return getIngestProposalReview(db, id);
}
