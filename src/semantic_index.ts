import { config } from "./config.ts";
import { DB, type SemanticIndexStatus } from "./db.ts";
import { type ActiveProviders, embeddingIdentity } from "./provider_runtime.ts";
import { parseWikiPage } from "./wiki.ts";

export const DEFAULT_SEMANTIC_REBUILD_LIMIT = 20;
export const MAX_SEMANTIC_REBUILD_LIMIT = 100;

export interface SemanticIndexRebuildResult extends SemanticIndexStatus {
  processed: number;
  links: number;
}

export function validateSemanticRebuildLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEMANTIC_REBUILD_LIMIT;
  if (
    !Number.isSafeInteger(value) || Number(value) < 1 ||
    Number(value) > MAX_SEMANTIC_REBUILD_LIMIT
  ) {
    throw new RangeError(
      `Semantic rebuild limit must be between 1 and ${MAX_SEMANTIC_REBUILD_LIMIT}`,
    );
  }
  return Number(value);
}

export async function rebuildSemanticIndex(
  db: DB,
  providers: ActiveProviders,
  limit = DEFAULT_SEMANTIC_REBUILD_LIMIT,
  onProgress?: (status: SemanticIndexStatus & { processed: number }) => void,
): Promise<SemanticIndexRebuildResult> {
  const boundedLimit = validateSemanticRebuildLimit(limit);
  const identity = embeddingIdentity(providers.embedding);
  let status = db.activateSemanticIndex(identity);
  if (!status.complete) db.clearLinks();

  let processed = 0;
  for (const note of db.getNotesWithoutEmbeddings(boundedLimit)) {
    const before = await Deno.readTextFile(note.file_path);
    const page = parseWikiPage(before);
    const embedding = await DB.embedText(
      `${page.title}\n${page.body}`,
      providers.embedding.apiBase,
      providers.embedding.apiKey,
      providers.embedding.model,
      "document",
    );
    if (await Deno.readTextFile(note.file_path) !== before) {
      throw new Error(
        `Wiki page "${note.title}" changed during semantic indexing`,
      );
    }
    db.upsertEmbedding(note.id, embedding);
    processed++;
    status = db.semanticIndexStatus(identity);
    onProgress?.({ ...status, processed });
  }

  status = db.semanticIndexStatus(identity);
  const links = status.complete ? db.computeLinks(config.link.k) : 0;
  return { ...status, processed, links };
}
