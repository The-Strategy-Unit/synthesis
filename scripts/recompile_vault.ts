#!/usr/bin/env -S deno run

import { relative, resolve, sep } from "node:path";

import {
  ensureRecompileVaultLayout,
  loadArchivedVaultSources,
} from "../src/vault_archive.ts";
import type { WikiChange } from "../src/wiki.ts";

export interface RecompileArguments {
  source: string;
  destination: string;
  extractModel: string;
  editorModel: string;
  embeddingModel: string;
  confirmation: string;
  resume: boolean;
}

function argumentValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function modelName(value: string, flag: string): string {
  if (value.length > 200 || /\p{Cc}/u.test(value)) {
    throw new Error(`${flag} is invalid`);
  }
  return value;
}

export function parseRecompileArguments(
  args: readonly string[],
): RecompileArguments {
  const values = new Map<string, string>();
  let resume = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--resume") {
      if (resume) throw new Error("--resume may be supplied only once");
      resume = true;
      continue;
    }
    if (
      ![
        "--source",
        "--destination",
        "--extract-model",
        "--editor-model",
        "--embedding-model",
        "--confirm",
      ].includes(flag)
    ) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
    values.set(flag, argumentValue(args, index, flag));
    index++;
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    source: resolve(required("--source")),
    destination: resolve(required("--destination")),
    extractModel: modelName(required("--extract-model"), "--extract-model"),
    editorModel: modelName(required("--editor-model"), "--editor-model"),
    embeddingModel: modelName(
      values.get("--embedding-model") ?? "nomic-embed-text-v2-moe:latest",
      "--embedding-model",
    ),
    confirmation: required("--confirm"),
    resume,
  };
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function destinationPreflight(
  source: string,
  destination: string,
  resume: boolean,
): Promise<void> {
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error("Source and destination vaults must be separate siblings");
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(destination);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      if (resume) throw new Error("Cannot resume: destination does not exist");
      return;
    }
    throw error;
  }
  if (!info.isDirectory || info.isSymlink) {
    throw new Error("Destination must be an ordinary directory");
  }
  if (resume) {
    for (const file of ["vault.json", "schema.md"]) {
      const fileInfo = await Deno.lstat(`${destination}/${file}`);
      if (!fileInfo.isFile || fileInfo.isSymlink) {
        throw new Error(`Cannot resume: destination ${file} is invalid`);
      }
    }
    return;
  }
  for await (const _entry of Deno.readDir(destination)) {
    throw new Error(
      "Destination must be empty; use --resume only for an interrupted recompilation",
    );
  }
}

async function readSourceSchema(source: string): Promise<string> {
  const path = `${source}/schema.md`;
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > 64 * 1024) {
    throw new Error("Source vault schema.md must be a bounded ordinary file");
  }
  return await Deno.readTextFile(path);
}

export function sourceHashesInWikiLog(log: string): Set<string> {
  return new Set(
    Array.from(
      log.matchAll(/^- Source SHA-256: `([a-f0-9]{64})`$/gm),
      (match) => match[1],
    ),
  );
}

export function recompileLogAction(
  action: string,
): WikiChange["action"] {
  if (action === "new") return "create";
  if (action === "merge") return "update";
  if (action === "contradict") return "contradict";
  throw new Error(`Recompiled source has invalid note action: ${action}`);
}

async function loggedSourceHashes(destination: string): Promise<Set<string>> {
  try {
    return sourceHashesInWikiLog(
      await Deno.readTextFile(`${destination}/notes/log.md`),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Set();
    throw error;
  }
}

async function runRecompile(args: RecompileArguments): Promise<void> {
  const sources = await loadArchivedVaultSources(args.source);
  const expectedConfirmation = `RECOMPILE ${sources.length} SOURCES`;
  if (args.confirmation !== expectedConfirmation) {
    throw new Error(`Confirmation must be exactly: ${expectedConfirmation}`);
  }
  await destinationPreflight(args.source, args.destination, args.resume);

  Deno.env.set("SYNTHESIS_VAULT", args.destination);
  Deno.env.set("SYNTHESIS_EXTRACT_MODEL", args.extractModel);
  Deno.env.set("SYNTHESIS_CONSOLIDATE_MODEL", args.editorModel);
  Deno.env.set("SYNTHESIS_INTEGRATE_MODEL", args.editorModel);
  Deno.env.set("SYNTHESIS_REWRITE_MODEL", args.editorModel);
  Deno.env.set("SYNTHESIS_EMBED_MODEL", args.embeddingModel);

  const [
    { config, dbPath },
    { DB },
    { ensureVaultManifest },
    { loadWikiSchema, saveWikiSchema, validateWikiSchema },
    { approveIngestProposal, stageSingleSource },
    { checkProviderReadiness, environmentProviders },
    { appendWikiLog, rebuildWikiIndex },
    { parseWikiPage },
  ] = await Promise.all([
    import("../src/config.ts"),
    import("../src/db.ts"),
    import("../src/vault_manifest.ts"),
    import("../src/wiki_schema.ts"),
    import("../src/orchestrate.ts"),
    import("../src/provider_runtime.ts"),
    import("../src/wiki_store.ts"),
    import("../src/wiki.ts"),
  ]);

  const providers = environmentProviders();
  const readiness = await checkProviderReadiness(providers);
  if (!readiness.ready) {
    const missing = [
      ...readiness.chat.missingModels,
      ...readiness.embedding.missingModels,
    ];
    throw new Error(
      `Provider is not ready; missing models: ${
        missing.join(", ") || "unknown"
      }`,
    );
  }

  const sourceSchema = validateWikiSchema(
    await readSourceSchema(args.source),
  );
  await ensureVaultManifest();
  await ensureRecompileVaultLayout(args.destination);
  if (args.resume) {
    const destinationSchema = await loadWikiSchema();
    if (destinationSchema !== sourceSchema) {
      throw new Error(
        "Cannot resume because the destination schema differs from the source vault",
      );
    }
  } else {
    await saveWikiSchema(sourceSchema);
  }

  const db = new DB(dbPath());
  const batchId = crypto.randomUUID();
  try {
    await rebuildWikiIndex(db);
    const loggedHashes = await loggedSourceHashes(args.destination);
    console.log(
      `Recompiling ${sources.length} archived sources\n` +
        `  extract: ${args.extractModel}\n` +
        `  edit: ${args.editorModel}\n` +
        `  embed: ${args.embeddingModel}\n` +
        `  destination: ${args.destination}`,
    );
    for (let index = 0; index < sources.length; index++) {
      const { contentHash, archivedAt: _archivedAt, ...source } =
        sources[index];
      const prefix = `[${index + 1}/${sources.length}]`;
      console.log(`${prefix} ${source.title}`);
      let lastStage = "";
      const send = (stage: string) => {
        if (stage !== lastStage) console.log(`${prefix}   ${stage}`);
        lastStage = stage;
      };
      const staged = await stageSingleSource(
        db,
        source,
        source.sourceType === "text",
        send,
        providers,
      );
      if (staged.kind === "already-applied") {
        if (!loggedHashes.has(contentHash)) {
          const storedSource = db.getSourceByHash(contentHash);
          if (!storedSource) {
            throw new Error(
              `Applied source ${contentHash} is missing from the catalogue`,
            );
          }
          const changes: WikiChange[] = [];
          for (const note of db.getNotesForSource(storedSource.id)) {
            const page = parseWikiPage(
              await Deno.readTextFile(note.file_path),
            );
            changes.push({
              action: recompileLogAction(note.action),
              pageTitle: page.title,
              pageType: page.type,
            });
          }
          await appendWikiLog({
            operation: "ingest",
            subject: storedSource.title,
            contentHash,
            changes,
          });
          loggedHashes.add(contentHash);
          console.log(`${prefix}   repaired catalogue log`);
        }
        console.log(`${prefix}   already applied`);
        continue;
      }
      const selection = staged.proposal.changes.map((_change, changeIndex) => ({
        index: changeIndex,
      }));
      const applied = await approveIngestProposal(
        db,
        staged.proposal.id,
        send,
        providers,
        { changes: selection },
        { reviewMode: "automatic", batchId },
      );
      console.log(
        `${prefix}   accepted: ${applied.newCount} new, ${applied.mergeCount} merged, ${applied.contradictCount} conflicting`,
      );
    }

    const semanticIndex = db.semanticIndexStatus();
    if (!semanticIndex.complete) {
      throw new Error(
        `Semantic index is incomplete (${semanticIndex.embedded}/${semanticIndex.total} pages)`,
      );
    }
    const linkCount = db.computeLinks(config.link.k);
    console.log(
      `Recompilation complete: ${db.getAllNotes().length} pages, ${linkCount} semantic proximity suggestions.`,
    );
  } finally {
    db.close();
  }
}

function usage(): string {
  return `Usage:
  deno run <permissions> scripts/recompile_vault.ts \\
    --source <existing-vault> --destination <new-vault> \\
    --extract-model <model> --editor-model <model> \\
    [--embedding-model <model>] \\
    --confirm "RECOMPILE N SOURCES" [--resume]`;
}

if (import.meta.main) {
  let args: RecompileArguments;
  try {
    args = parseRecompileArguments(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    Deno.exit(1);
  }
  try {
    await runRecompile(args!);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
