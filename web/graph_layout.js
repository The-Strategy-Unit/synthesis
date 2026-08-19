function endpointId(endpoint) {
  return endpoint && typeof endpoint === "object" ? endpoint.id : endpoint;
}

function linkKey(link) {
  const source = endpointId(link.source);
  const target = endpointId(link.target);
  return source < target ? `${source}:${target}` : `${target}:${source}`;
}

function semanticSimilarity(link) {
  const similarity = Number(link.similarity);
  return Number.isFinite(similarity) ? similarity : -1;
}

export function semanticNeighborLinks(nodes, links, neighborsPerPage) {
  if (!Number.isSafeInteger(neighborsPerPage) || neighborsPerPage < 0) {
    throw new RangeError("Semantic neighbour breadth must be non-negative");
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incident = new Map(nodes.map((node) => [node.id, []]));
  const explicit = [];
  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) {
      continue;
    }
    if (link.kind === "explicit") {
      explicit.push(link);
      continue;
    }
    incident.get(source)?.push(link);
    incident.get(target)?.push(link);
  }

  const selected = new Set();
  for (const candidates of incident.values()) {
    candidates.sort((left, right) =>
      semanticSimilarity(right) - semanticSimilarity(left) ||
      linkKey(left).localeCompare(linkKey(right))
    );
    for (const link of candidates.slice(0, neighborsPerPage)) {
      selected.add(linkKey(link));
    }
  }

  return [
    ...explicit,
    ...links.filter((link) =>
      link.kind === "semantic" && selected.has(linkKey(link))
    ),
  ];
}

export function semanticSimilarityRange(links) {
  const similarities = links
    .filter((link) => link.kind === "semantic")
    .map(semanticSimilarity)
    .filter((similarity) => similarity >= -1 && similarity <= 1);
  return similarities.length === 0
    ? { min: 0, max: 1 }
    : { min: Math.min(...similarities), max: Math.max(...similarities) };
}

function normalizedSimilarity(link, range) {
  if (link.kind !== "semantic") return 0;
  const width = range.max - range.min;
  if (width <= Number.EPSILON) return 0.5;
  return Math.max(
    0,
    Math.min(1, (semanticSimilarity(link) - range.min) / width),
  );
}

export function graphLinkDistance(link, range) {
  if (link.kind === "explicit") return 105;
  return 130 - 80 * normalizedSimilarity(link, range);
}

export function graphLinkStrength(link, range) {
  if (link.kind === "explicit") return 0.08;
  return 0.22 + 0.58 * normalizedSimilarity(link, range);
}

export function seededGraphRandom(seed = 0x51_7a_2f_19) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
