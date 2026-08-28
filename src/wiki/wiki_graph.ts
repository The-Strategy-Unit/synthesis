import type { DB } from "../catalogue/db.ts";
import { parseWikiPage, type WikiRelationship } from "./wiki.ts";

export interface WikiGraphNode {
  id: number;
  title: string;
}

export type WikiGraphLink =
  | {
    source: number;
    target: number;
    kind: "explicit";
    relationships?: WikiRelationship[];
  }
  | {
    source: number;
    target: number;
    kind: "semantic";
    similarity: number;
  };

export interface WikiGraph {
  nodes: WikiGraphNode[];
  links: WikiGraphLink[];
}

function normalisedTitle(title: string): string {
  return title.toLocaleLowerCase("en-GB");
}

function edgeKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

export async function buildWikiGraph(db: DB): Promise<WikiGraph> {
  const notes = db.notes.getAllNotes();
  const idsByTitle = new Map<string, number[]>();
  for (const note of notes) {
    const key = normalisedTitle(note.title);
    idsByTitle.set(key, [...(idsByTitle.get(key) ?? []), note.id]);
  }

  const explicit = new Map<string, WikiGraphLink>();
  for (const note of notes) {
    let page;
    try {
      page = parseWikiPage(await Deno.readTextFile(note.file_path));
    } catch {
      continue;
    }
    for (const title of page.links) {
      const targetIds = idsByTitle.get(normalisedTitle(title));
      if (targetIds?.length !== 1 || targetIds[0] === note.id) continue;
      const targetId = targetIds[0];
      const key = edgeKey(note.id, targetId);
      const relationship = page.relationships?.filter((item) =>
        normalisedTitle(item.target) === normalisedTitle(title)
      ) ?? [];
      const existing = explicit.get(key);
      explicit.set(key, {
        source: Math.min(note.id, targetId),
        target: Math.max(note.id, targetId),
        kind: "explicit",
        ...((existing?.kind === "explicit" && existing.relationships) ||
            relationship.length > 0
          ? {
            relationships: [
              ...(existing?.kind === "explicit"
                ? existing.relationships ?? []
                : []),
              ...relationship,
            ],
          }
          : {}),
      });
    }
  }

  const semantic = new Map<string, WikiGraphLink>();
  for (const link of db.search.getLinks()) {
    const key = edgeKey(link.source, link.target);
    if (explicit.has(key)) continue;
    semantic.set(key, {
      source: Math.min(link.source, link.target),
      target: Math.max(link.source, link.target),
      kind: "semantic",
      similarity: link.similarity,
    });
  }

  return {
    nodes: notes.map((note) => ({ id: note.id, title: note.title })),
    links: [
      ...[...explicit.values()].sort((left, right) =>
        left.source - right.source || left.target - right.target
      ),
      ...[...semantic.values()].sort((left, right) =>
        left.source - right.source || left.target - right.target
      ),
    ],
  };
}

export async function getRelatedWikiPages(
  db: DB,
  noteId: number,
): Promise<
  Array<{
    id: number;
    title: string;
    kind: "explicit" | "semantic";
    similarity?: number;
    relationships?: WikiRelationship[];
  }>
> {
  const graph = await buildWikiGraph(db);
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  return graph.links.flatMap((link) => {
    const relatedId = link.source === noteId
      ? link.target
      : link.target === noteId
      ? link.source
      : undefined;
    const title = relatedId === undefined ? undefined : titles.get(relatedId);
    if (relatedId === undefined || title === undefined) return [];
    return [{
      id: relatedId,
      title,
      kind: link.kind,
      ...(link.kind === "semantic" ? { similarity: link.similarity } : {}),
      ...(link.kind === "explicit" && link.relationships
        ? { relationships: link.relationships }
        : {}),
    }];
  }).sort((left, right) =>
    Number(left.kind === "semantic") - Number(right.kind === "semantic") ||
    (right.similarity ?? 1) - (left.similarity ?? 1) ||
    left.title.localeCompare(right.title, "en-GB", { sensitivity: "base" })
  );
}
