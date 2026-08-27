export type WikiPageType = "concept" | "entity" | "synthesis";

export type WikiRelationshipType =
  | "consolidation_candidate"
  | "supports"
  | "contradicts"
  | "mechanistic"
  | "causal_hypothesis"
  | "temporal"
  | "depends_on"
  | "analogous"
  | "shared_constraint"
  | "research_gap";

export interface WikiRelationship {
  target: string;
  type: WikiRelationshipType;
  explanation: string;
  significance: string;
  pageHashes: string[];
  confirmedAt: string;
}

export interface WikiPage {
  title: string;
  type: WikiPageType;
  body: string;
  tags: string[];
  links: string[];
  relationships?: WikiRelationship[];
}

export interface WikiChange {
  action: "create" | "update" | "contradict";
  pageTitle: string;
  pageType: WikiPageType;
}

export interface WikiIndexEntry {
  title: string;
  type: WikiPageType;
  summary: string;
}

export interface WikiLogEntry {
  timestamp: string;
  operation: "ingest" | "query" | "lint" | "discovery";
  subject: string;
  contentHash?: string;
  changes: WikiChange[];
}

export interface SourceReference {
  title: string;
  url?: string;
  contentHash: string;
  pages?: number[];
}

export interface ClaimCitation {
  text: string;
  sourceHashes: string[];
}

const PAGE_TYPES = new Set<WikiPageType>([
  "concept",
  "entity",
  "synthesis",
]);
const MAX_TITLE_LENGTH = 120;
const MAX_SOURCE_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 20_000;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 64;
const MAX_LINKS = 50;
const MAX_RELATIONSHIPS = 50;
const MAX_SOURCE_PAGES = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELATIONSHIP_TYPES = new Set<WikiRelationshipType>([
  "consolidation_candidate",
  "supports",
  "contradicts",
  "mechanistic",
  "causal_hypothesis",
  "temporal",
  "depends_on",
  "analogous",
  "shared_constraint",
  "research_gap",
]);
const CLAIM_MARKER_PATTERN =
  /^<!-- synthesis-claim:([a-f0-9]{64}(?:,[a-f0-9]{64})*) -->$/;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(
  value: unknown,
  context: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  const text = value.trim();
  if (!text) throw new Error(`${context} must not be empty`);
  if (text.length > maxLength) {
    throw new Error(`${context} exceeds ${maxLength} characters`);
  }
  if (/\p{Cc}/u.test(text)) {
    throw new Error(`${context} must not contain control characters`);
  }
  return text;
}

function pageTitle(value: unknown, context: string): string {
  const title = requiredText(value, context, MAX_TITLE_LENGTH);
  if (title.includes("[[") || title.includes("]]")) {
    throw new Error(`${context} must not contain wiki-link delimiters`);
  }
  return title;
}

function markdownBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Wiki page.body must be a string");
  }
  const body = value.trim().replace(/\r\n?/g, "\n");
  if (!body) throw new Error("Wiki page.body must not be empty");
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`Wiki page.body exceeds ${MAX_BODY_LENGTH} characters`);
  }
  const containsDisallowedControl = [...body].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (codePoint < 32 && codePoint !== 9 && codePoint !== 10) ||
      (codePoint >= 127 && codePoint <= 159);
  });
  if (containsDisallowedControl) {
    throw new Error("Wiki page.body must not contain control characters");
  }
  if (/^## (?:Related|Sources)\s*$/m.test(body)) {
    throw new Error(
      "Wiki page.body must not contain compiler-managed Related or Sources headings",
    );
  }
  if (/^<!-- synthesis-claim:.* -->$/m.test(body)) {
    throw new Error(
      "Wiki page.body must not contain compiler-managed claim citations",
    );
  }
  return body;
}

function stringArray(
  value: unknown,
  context: string,
  maxItems: number,
  parseItem: (item: unknown, context: string) => string,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  if (value.length > maxItems) {
    throw new Error(`${context} must contain at most ${maxItems} items`);
  }

  const unique = new Map<string, string>();
  value.forEach((item, index) => {
    const parsed = parseItem(item, `${context}[${index}]`);
    const key = parsed.toLocaleLowerCase("en-GB");
    if (!unique.has(key)) unique.set(key, parsed);
  });
  return [...unique.values()];
}

export function validateWikiPage(value: unknown): WikiPage {
  const page = asRecord(value, "Wiki page");
  if (
    typeof page.type !== "string" || !PAGE_TYPES.has(page.type as WikiPageType)
  ) {
    throw new Error("Wiki page.type must be concept, entity, or synthesis");
  }

  const title = pageTitle(page.title, "Wiki page.title");
  const links = stringArray(
    page.links,
    "Wiki page.links",
    MAX_LINKS,
    pageTitle,
  ).filter((link) =>
    link.toLocaleLowerCase("en-GB") !== title.toLocaleLowerCase("en-GB")
  );

  const relationships = page.relationships === undefined
    ? undefined
    : validateWikiRelationships(page.relationships, title, links);

  return {
    title,
    type: page.type as WikiPageType,
    body: markdownBody(page.body),
    tags: stringArray(
      page.tags,
      "Wiki page.tags",
      MAX_TAGS,
      (tag, context) => requiredText(tag, context, MAX_TAG_LENGTH),
    ),
    links,
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function validateWikiRelationships(
  value: unknown,
  pageTitleValue: string,
  links: string[],
): WikiRelationship[] {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new Error(
      `Wiki page.relationships must contain at most ${MAX_RELATIONSHIPS} items`,
    );
  }
  const linkKeys = new Set(
    links.map((link) => link.toLocaleLowerCase("en-GB")),
  );
  const unique = new Map<string, WikiRelationship>();
  value.forEach((item, index) => {
    const context = `Wiki page.relationships[${index}]`;
    const relationship = asRecord(item, context);
    const target = pageTitle(relationship.target, `${context}.target`);
    if (
      target.toLocaleLowerCase("en-GB") ===
        pageTitleValue.toLocaleLowerCase("en-GB")
    ) {
      throw new Error(`${context}.target must reference another page`);
    }
    if (!linkKeys.has(target.toLocaleLowerCase("en-GB"))) {
      throw new Error(`${context}.target must also appear in Wiki page.links`);
    }
    if (
      typeof relationship.type !== "string" ||
      !RELATIONSHIP_TYPES.has(relationship.type as WikiRelationshipType)
    ) {
      throw new Error(`${context}.type is not supported`);
    }
    if (
      !Array.isArray(relationship.pageHashes) ||
      relationship.pageHashes.length < 2 ||
      relationship.pageHashes.length > 4 ||
      relationship.pageHashes.some((hash) =>
        typeof hash !== "string" || !SHA256_PATTERN.test(hash)
      )
    ) {
      throw new Error(`${context}.pageHashes must contain 2-4 SHA-256 hashes`);
    }
    const confirmedAt = requiredText(
      relationship.confirmedAt,
      `${context}.confirmedAt`,
      40,
    );
    if (!Number.isFinite(Date.parse(confirmedAt))) {
      throw new Error(`${context}.confirmedAt must be an ISO timestamp`);
    }
    const parsed: WikiRelationship = {
      target,
      type: relationship.type as WikiRelationshipType,
      explanation: requiredText(
        relationship.explanation,
        `${context}.explanation`,
        1_000,
      ),
      significance: requiredText(
        relationship.significance,
        `${context}.significance`,
        1_000,
      ),
      pageHashes: [...new Set(relationship.pageHashes as string[])],
      confirmedAt: new Date(confirmedAt).toISOString(),
    };
    unique.set(
      `${target.toLocaleLowerCase("en-GB")}|${parsed.type}`,
      parsed,
    );
  });
  return [...unique.values()];
}

export function renderWikiLink(title: string): string {
  return `[[${pageTitle(title, "Wiki link title")}]]`;
}

const INDEX_HEADINGS: ReadonlyArray<[WikiPageType, string]> = [
  ["entity", "Entities"],
  ["concept", "Concepts"],
  ["synthesis", "Syntheses"],
];

function oneLineSummary(value: unknown): string {
  const normalised = typeof value === "string"
    ? value.replace(/\s+/g, " ")
    : value;
  const summary = requiredText(normalised, "Wiki index summary", 1_000);
  return summary.length <= 200
    ? summary
    : `${summary.slice(0, 197).trimEnd()}…`;
}

export function renderWikiIndex(entryValues: WikiIndexEntry[]): string {
  const entries = entryValues.map((entry) => ({
    title: pageTitle(entry.title, "Wiki index title"),
    type: PAGE_TYPES.has(entry.type) ? entry.type : undefined,
    summary: oneLineSummary(entry.summary),
  }));
  if (entries.some((entry) => entry.type === undefined)) {
    throw new Error(
      "Wiki index entry type must be concept, entity, or synthesis",
    );
  }

  const sections = [
    "# Synthesis Wiki",
    "This index is maintained automatically from compiled wiki pages.",
  ];
  for (const [type, heading] of INDEX_HEADINGS) {
    const pages = entries
      .filter((entry) => entry.type === type)
      .sort((left, right) =>
        left.title.localeCompare(right.title, "en-GB", { sensitivity: "base" })
      );
    if (pages.length === 0) continue;
    sections.push(
      `## ${heading}\n\n${
        pages.map((entry) =>
          `- ${renderWikiLink(entry.title)} — ${entry.summary}`
        ).join("\n")
      }`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

function validateTimestamp(value: unknown): string {
  const timestamp = requiredText(value, "Wiki log timestamp", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new Error("Wiki log timestamp must be an ISO UTC timestamp");
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Wiki log timestamp is invalid");
  }
  return timestamp;
}

export function renderWikiLogEntry(entry: WikiLogEntry): string {
  const timestamp = validateTimestamp(entry.timestamp);
  if (!["ingest", "query", "lint", "discovery"].includes(entry.operation)) {
    throw new Error(
      "Wiki log operation must be ingest, query, lint, or discovery",
    );
  }
  const subject = requiredText(entry.subject, "Wiki log subject", 500);
  if (
    entry.contentHash !== undefined && !SHA256_PATTERN.test(entry.contentHash)
  ) {
    throw new Error("Wiki log contentHash must be a lowercase SHA-256 digest");
  }

  const lines = [`## [${timestamp}] ${entry.operation} | ${subject}`];
  if (entry.contentHash) {
    lines.push(`- Source SHA-256: \`${entry.contentHash}\``);
  }
  for (const change of entry.changes) {
    if (!["create", "update", "contradict"].includes(change.action)) {
      throw new Error(
        "Wiki change action must be create, update, or contradict",
      );
    }
    if (!PAGE_TYPES.has(change.pageType)) {
      throw new Error(
        "Wiki change pageType must be concept, entity, or synthesis",
      );
    }
    lines.push(
      `- ${change.action} ${change.pageType}: ${
        renderWikiLink(change.pageTitle)
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseJsonField(
  fields: ReadonlyMap<string, string>,
  name: string,
): unknown {
  const value = fields.get(name);
  if (value === undefined) {
    throw new Error(`Wiki frontmatter.${name} is missing`);
  }
  try {
    return JSON.parse(withoutJsonTrailingCommas(value));
  } catch {
    throw new Error(`Wiki frontmatter.${name} is invalid JSON`);
  }
}

function withoutJsonTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/.test(value[next] ?? "")) next++;
      if (value[next] === "]" || value[next] === "}") continue;
    }
    result += character;
  }
  return result;
}

function parseFrontmatterFields(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  let name: string | undefined;
  let fragments: string[] = [];

  const commit = () => {
    if (name === undefined) return;
    if (fields.has(name)) {
      throw new Error(`Wiki frontmatter.${name} is duplicated`);
    }
    fields.set(name, fragments.join(" ").trim());
  };

  for (const line of frontmatter.split("\n")) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (field) {
      commit();
      name = field[1];
      fragments = field[2] ? [field[2].trim()] : [];
      continue;
    }
    const continuation = line.trim();
    if (name === undefined || !continuation) {
      throw new Error("Wiki frontmatter contains an invalid field");
    }
    fragments.push(continuation);
  }
  commit();
  return fields;
}

export function parseWikiPage(markdown: string): WikiPage {
  const normalised = markdown.replace(/\r\n?/g, "\n");
  const frontmatter = normalised.match(/^---\n([\s\S]*?)\n---\n+/);
  if (!frontmatter) throw new Error("Wiki page has invalid frontmatter");

  const fields = parseFrontmatterFields(frontmatter[1]);

  const title = parseJsonField(fields, "title");
  const type = fields.get("type");
  const tags = parseJsonField(fields, "tags");
  const links = parseJsonField(fields, "links");
  const relationships = fields.has("relationships")
    ? parseJsonField(fields, "relationships")
    : undefined;
  const content = normalised.slice(frontmatter[0].length);
  const headingEnd = content.indexOf("\n");
  if (headingEnd === -1 || !content.startsWith("# ")) {
    throw new Error("Wiki page must start with a level-one title");
  }
  const heading = content.slice(2, headingEnd).trim();
  if (heading !== title) {
    throw new Error("Wiki page heading does not match frontmatter.title");
  }

  const afterHeading = content.slice(headingEnd + 1).replace(/^\n/, "");
  const relatedAt = afterHeading.indexOf("\n\n## Related\n");
  const sourcesAt = afterHeading.indexOf("\n\n## Sources\n");
  const boundaries = [relatedAt, sourcesAt].filter((index) => index >= 0);
  const bodyEnd = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  const body = afterHeading.slice(0, bodyEnd).trim().split("\n")
    .filter((line) => !CLAIM_MARKER_PATTERN.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return validateWikiPage({
    title,
    type,
    body,
    tags,
    links,
    ...(relationships === undefined ? {} : { relationships }),
  });
}

function validateSourceReference(source: SourceReference): SourceReference {
  const title = requiredText(
    source.title,
    "Source title",
    MAX_SOURCE_TITLE_LENGTH,
  );
  if (!SHA256_PATTERN.test(source.contentHash)) {
    throw new Error("Source contentHash must be a lowercase SHA-256 digest");
  }

  let url: string | undefined;
  if (source.url !== undefined) {
    const candidate = requiredText(source.url, "Source URL", 2_048);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("Source URL must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Source URL must use HTTP or HTTPS");
    }
    url = parsed.href;
  }

  let pages: number[] | undefined;
  if (source.pages !== undefined) {
    if (
      !Array.isArray(source.pages) ||
      source.pages.length === 0 ||
      source.pages.length > MAX_SOURCE_PAGES ||
      source.pages.some((page) => !Number.isSafeInteger(page) || page < 1)
    ) {
      throw new Error(
        `Source pages must contain 1-${MAX_SOURCE_PAGES} positive integers`,
      );
    }
    pages = [...new Set(source.pages)].sort((left, right) => left - right);
  }

  return {
    title,
    url,
    contentHash: source.contentHash,
    ...(pages && { pages }),
  };
}

function sourceLine(source: SourceReference): string {
  const safeTitle = source.title.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const location = source.url
    ? `[${safeTitle}](<${source.url.replaceAll(">", "%3E")}>)`
    : safeTitle;
  const pages = source.pages?.length
    ? `; pages: ${source.pages.join(", ")}`
    : "";
  return `- ${location}${pages}; SHA-256: \`${source.contentHash}\` <!-- synthesis-source:${source.contentHash} -->`;
}

/** Read page locations from one compiler-managed Markdown source reference. */
export function findSourceReferencePages(
  markdown: string,
  contentHash: string,
): number[] | undefined {
  if (!SHA256_PATTERN.test(contentHash)) return undefined;
  const marker = `<!-- synthesis-source:${contentHash} -->`;
  const markerAt = markdown.indexOf(marker);
  if (markerAt === -1) return undefined;
  const bulletAt = markdown.lastIndexOf("\n- ", markerAt);
  const reference = markdown.slice(
    bulletAt === -1 ? 0 : bulletAt + 1,
    markerAt,
  );
  const match = reference.match(
    /;\s*pages:\s*(\d+(?:,\s*\d+)*)\s*;\s*SHA-256:/,
  );
  if (!match) return undefined;
  const pages = match[1].split(/,\s*/).map(Number);
  if (
    pages.length === 0 || pages.length > MAX_SOURCE_PAGES ||
    pages.some((page) => !Number.isSafeInteger(page) || page < 1)
  ) {
    return undefined;
  }
  return [...new Set(pages)].sort((left, right) => left - right);
}

/** Read unique immutable source hashes from compiler-managed references. */
export function findSourceReferenceHashes(markdown: string): string[] {
  const hashes = markdown.matchAll(
    /<!-- synthesis-source:([a-f0-9]{64}) -->/g,
  );
  return [...new Set(Array.from(hashes, (match) => match[1]))];
}

function claimBlocks(body: string): string[] {
  return body.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
}

function claimCitationBlocks(body: string): string[] {
  const merged: string[] = [];
  for (const block of claimBlocks(body)) {
    if (CLAIM_MARKER_PATTERN.test(block) && merged.length > 0) {
      const previous = merged.at(-1)!;
      const previousLastLine = previous.split("\n").at(-1) ?? "";
      if (!CLAIM_MARKER_PATTERN.test(previousLastLine)) {
        merged[merged.length - 1] = `${previous}\n${block}`;
        continue;
      }
    }
    merged.push(block);
  }
  return merged;
}

/** Read compiler-managed claim-to-source mappings, with a legacy fallback. */
export function findClaimCitations(markdown: string): ClaimCitation[] {
  const page = parseWikiPage(markdown);
  const normalised = markdown.replace(/\r\n?/g, "\n");
  const frontmatter = normalised.match(/^---\n[\s\S]*?\n---\n+/);
  if (!frontmatter) throw new Error("Wiki page has invalid frontmatter");
  const content = normalised.slice(frontmatter[0].length);
  const headingEnd = content.indexOf("\n");
  const afterHeading = content.slice(headingEnd + 1).replace(/^\n/, "");
  const relatedAt = afterHeading.indexOf("\n\n## Related\n");
  const sourcesAt = afterHeading.indexOf("\n\n## Sources\n");
  const boundaries = [relatedAt, sourcesAt].filter((index) => index >= 0);
  const bodyEnd = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  const rawBlocks = claimCitationBlocks(
    afterHeading.slice(0, bodyEnd).trim(),
  );
  const sourceHashes = findSourceReferenceHashes(markdown);
  const sourceSet = new Set(sourceHashes);
  const hasMarkers = rawBlocks.some((block) =>
    CLAIM_MARKER_PATTERN.test(block.split("\n").at(-1) ?? "")
  );

  if (!hasMarkers) {
    return claimBlocks(page.body).map((text) => ({ text, sourceHashes }));
  }

  return rawBlocks.map((block, index) => {
    const lines = block.split("\n");
    const marker = lines.pop()?.match(CLAIM_MARKER_PATTERN);
    if (!marker) {
      throw new Error(`Wiki claim ${index + 1} is missing source citations`);
    }
    const hashes = [...new Set(marker[1].split(","))];
    if (hashes.some((hash) => !sourceSet.has(hash))) {
      throw new Error(
        `Wiki claim ${
          index + 1
        } cites a source absent from the Sources section`,
      );
    }
    const text = lines.join("\n").trim();
    if (!text) throw new Error(`Wiki claim ${index + 1} must not be empty`);
    return { text, sourceHashes: hashes };
  });
}

export function renderWikiPage(
  pageValue: WikiPage,
  sourceValues: SourceReference[],
  claimValues?: ClaimCitation[],
): string {
  const page = validateWikiPage(pageValue);
  const sources = sourceValues.map(validateSourceReference);
  const sourceHashes = new Set(sources.map((source) => source.contentHash));
  const blocks = claimBlocks(page.body);
  const claims = claimValues ?? blocks.map((text) => ({
    text,
    sourceHashes: [...sourceHashes],
  }));
  if (
    claims.length !== blocks.length ||
    claims.some((claim, index) => claim.text.trim() !== blocks[index])
  ) {
    throw new Error("Wiki claim citations must match every body block");
  }
  if (sources.length === 0 && claimValues !== undefined) {
    throw new Error("Wiki claim citations require a Sources section");
  }
  if (sources.length > 0) {
    for (let index = 0; index < claims.length; index++) {
      if (
        claims[index].sourceHashes.length === 0 ||
        claims[index].sourceHashes.some((hash) => !sourceHashes.has(hash))
      ) {
        throw new Error(
          `Wiki claim ${
            index + 1
          } must cite sources present in the Sources section`,
        );
      }
    }
  }
  const renderedBody = sources.length === 0
    ? page.body
    : claims.map((claim) =>
      `${claim.text}\n<!-- synthesis-claim:${
        [...new Set(claim.sourceHashes)].join(",")
      } -->`
    ).join("\n\n");
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `type: ${page.type}`,
    `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `links: [${page.links.map((link) => JSON.stringify(link)).join(", ")}]`,
    ...(page.relationships?.length
      ? [`relationships: ${JSON.stringify(page.relationships)}`]
      : []),
    "---",
  ];
  const sections = [frontmatter.join("\n"), `# ${page.title}`, renderedBody];

  if (page.links.length > 0) {
    sections.push(
      `## Related\n\n${
        page.links.map((link) => `- ${renderWikiLink(link)}`).join("\n")
      }`,
    );
  }
  if (sources.length > 0) {
    sections.push(`## Sources\n\n${sources.map(sourceLine).join("\n")}`);
  }

  return `${sections.join("\n\n")}\n`;
}
