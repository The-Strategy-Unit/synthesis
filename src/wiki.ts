export type WikiPageType = "concept" | "entity" | "synthesis";

export interface WikiPage {
  title: string;
  type: WikiPageType;
  body: string;
  tags: string[];
  links: string[];
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
  operation: "ingest" | "query" | "lint";
  subject: string;
  contentHash?: string;
  changes: WikiChange[];
}

export interface SourceReference {
  title: string;
  url?: string;
  contentHash: string;
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
    const key = parsed.toLocaleLowerCase("en-US");
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
    link.toLocaleLowerCase("en-US") !== title.toLocaleLowerCase("en-US")
  );

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
  };
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
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ")
    : value;
  const summary = requiredText(normalized, "Wiki index summary", 1_000);
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
        left.title.localeCompare(right.title, "en-US", { sensitivity: "base" })
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
  if (!["ingest", "query", "lint"].includes(entry.operation)) {
    throw new Error("Wiki log operation must be ingest, query, or lint");
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
    return JSON.parse(value);
  } catch {
    throw new Error(`Wiki frontmatter.${name} is invalid JSON`);
  }
}

export function parseWikiPage(markdown: string): WikiPage {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n+/);
  if (!frontmatter) throw new Error("Wiki page has invalid frontmatter");

  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("Wiki frontmatter contains an invalid field");
    }
    const name = line.slice(0, separator).trim();
    if (fields.has(name)) {
      throw new Error(`Wiki frontmatter.${name} is duplicated`);
    }
    fields.set(name, line.slice(separator + 1).trim());
  }

  const title = parseJsonField(fields, "title");
  const type = fields.get("type");
  const tags = parseJsonField(fields, "tags");
  const links = parseJsonField(fields, "links");
  const content = normalized.slice(frontmatter[0].length);
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
  const body = afterHeading.slice(0, bodyEnd).trim();

  return validateWikiPage({ title, type, body, tags, links });
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

  return { title, url, contentHash: source.contentHash };
}

function sourceLine(source: SourceReference): string {
  const safeTitle = source.title.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const location = source.url
    ? `[${safeTitle}](<${source.url.replaceAll(">", "%3E")}>)`
    : safeTitle;
  return `- ${location}; SHA-256: \`${source.contentHash}\` <!-- synthesis-source:${source.contentHash} -->`;
}

export function renderWikiPage(
  pageValue: WikiPage,
  sourceValues: SourceReference[],
): string {
  const page = validateWikiPage(pageValue);
  const sources = sourceValues.map(validateSourceReference);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `type: ${page.type}`,
    `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `links: [${page.links.map((link) => JSON.stringify(link)).join(", ")}]`,
    "---",
  ];
  const sections = [frontmatter.join("\n"), `# ${page.title}`, page.body];

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
