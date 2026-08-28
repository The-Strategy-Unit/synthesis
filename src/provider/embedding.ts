export type EmbeddingPurpose = "document" | "query";

const NOMIC_V2_MODEL = "nomic-embed-text-v2-moe";

function baseModelName(model: string): string {
  const name = model.normalize("NFKC").trim().toLocaleLowerCase("en-GB");
  const tagSeparator = name.indexOf(":", name.lastIndexOf("/") + 1);
  const withoutTag = tagSeparator > -1 ? name.slice(0, tagSeparator) : name;
  return withoutTag.split("/").at(-1) ?? "";
}

export function usesNomicV2TaskPrefixes(model: string): boolean {
  return baseModelName(model) === NOMIC_V2_MODEL;
}

/** Apply the retrieval instruction required by the bundled Nomic v2 model. */
export function embeddingInput(
  text: string,
  model: string,
  purpose: EmbeddingPurpose,
): string {
  if (!usesNomicV2TaskPrefixes(model)) return text;
  const prefix = purpose === "query" ? "search_query: " : "search_document: ";
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}
