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

export function semanticNeighbourLinks(nodes, links, neighboursPerPage) {
  if (!Number.isSafeInteger(neighboursPerPage) || neighboursPerPage < 0) {
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
    for (const link of candidates.slice(0, neighboursPerPage)) {
      selected.add(linkKey(link));
    }
  }

  return [
    ...links.filter((link) =>
      link.kind === "semantic" && selected.has(linkKey(link))
    ),
    // SVG paints later elements on top. Keep reviewed links above proximity
    // suggestions where unrelated edges cross.
    ...explicit,
  ];
}

export function searchContextGraph(nodes, links, resultIds) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const matches = new Set(
    [...resultIds].filter((id) => nodeIds.has(id)),
  );
  const included = new Set(matches);

  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (matches.has(source) || matches.has(target)) {
      included.add(source);
      included.add(target);
    }
  }

  return {
    nodes: nodes.filter((node) => included.has(node.id)),
    links: links.filter((link) =>
      included.has(endpointId(link.source)) &&
      included.has(endpointId(link.target))
    ),
    matchedIds: matches,
  };
}

export function graphFocusNodeIds(nodes, links, focusId) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(focusId)) return new Set();
  const focused = new Set([focusId]);
  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (source === focusId && nodeIds.has(target)) focused.add(target);
    if (target === focusId && nodeIds.has(source)) focused.add(source);
  }
  return focused;
}

export function graphNeighbourRows(nodes, links, focusId) {
  const pages = new Map(nodes.map((node) => [node.id, node]));
  if (!pages.has(focusId)) return [];
  const neighbours = new Map();
  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    const id = source === focusId ? target : target === focusId ? source : null;
    if (id === focusId || !pages.has(id)) continue;
    if (link.kind !== "explicit" && link.kind !== "semantic") continue;
    if (!neighbours.has(id)) neighbours.set(id, new Set());
    neighbours.get(id).add(link.kind);
  }
  return [...neighbours].map(([id, kinds]) => ({
    id,
    title: pages.get(id).title,
    kinds: [...kinds].sort(),
  })).sort((a, b) =>
    Number(b.kinds.includes("explicit")) -
      Number(a.kinds.includes("explicit")) ||
    a.title.localeCompare(b.title) || a.id - b.id
  );
}

// The renderer supplies actual font metrics; long words are split without
// breaking surrogate pairs. Full titles remain available in the linked list.
export function graphLabelLines(title, measure, maxWidth = 180) {
  let remaining = [
    ...(String(title).trim().replace(/\s+/gu, " ") || "Untitled page"),
  ];
  const lines = [];
  for (let line = 0; line < 2 && remaining.length > 0; line++) {
    const text = remaining.join("");
    if (measure(text) <= maxWidth) {
      lines.push(text);
      break;
    }
    const suffix = line === 1 ? "…" : "";
    let length = 0;
    while (
      length < remaining.length &&
      measure(remaining.slice(0, length + 1).join("") + suffix) <= maxWidth
    ) {
      length++;
    }
    if (length === 0) break;
    const prefix = remaining.slice(0, length).join("");
    const boundary = prefix.lastIndexOf(" ");
    if (boundary > 0 && remaining[length] !== " ") {
      length = [...prefix.slice(0, boundary)].length;
    }
    lines.push(remaining.slice(0, length).join("").trimEnd() + suffix);
    remaining = [...remaining.slice(length).join("").trimStart()];
  }
  return lines;
}

// Screen-space greedy placement: interaction, search, neighbours, then overview
// landmarks. Previous labels win ties to reduce flicker. A spatial index bounds
// collision checks; quiet regions still get labels even in a hub-heavy graph.
export function graphLabelLayout(
  candidates,
  width,
  height,
  { previousIds = new Set(), padding = 10 } = {},
) {
  const placed = new Map();
  if (!(width > 0 && height > 0)) return placed;
  const cells = new Map();
  function cellKeys(box) {
    const keys = [];
    for (
      let x = Math.floor(box.x / 96);
      x <= Math.floor((box.x + box.width) / 96);
      x++
    ) {
      for (
        let y = Math.floor(box.y / 96);
        y <= Math.floor((box.y + box.height) / 96);
        y++
      ) {
        keys.push(`${x}:${y}`);
      }
    }
    return keys;
  }
  const overlaps = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
  const ordered = [...candidates].sort((a, b) =>
    a.priority - b.priority ||
    Number(previousIds.has(b.id)) - Number(previousIds.has(a.id)) ||
    b.degree - a.degree || a.id - b.id
  );
  for (const item of ordered) {
    if (
      !Number.isFinite(item.x) || !Number.isFinite(item.y) ||
      item.x < 0 || item.x > width || item.y < 0 || item.y > height ||
      !(item.width > 0 && item.height > 0) ||
      item.width + 8 > width || item.height + 8 > height
    ) continue;
    const offset = item.radius + 6;
    const positions = [
      [item.x + offset, item.y - item.height / 2],
      [item.x - offset - item.width, item.y - item.height / 2],
      [item.x - item.width / 2, item.y - offset - item.height],
      [item.x - item.width / 2, item.y + offset],
    ].map(([x, y]) => ({
      x: Math.max(4, Math.min(width - item.width - 4, x)),
      y: Math.max(4, Math.min(height - item.height - 4, y)),
      width: item.width,
      height: item.height,
    }));
    const chosen = positions.find((box) =>
      cellKeys(box).every((key) =>
        (cells.get(key) ?? []).every((other) =>
          !overlaps(box, other)
        )
      )
    ) ?? (item.priority <= 1 ? positions[0] : undefined);
    if (!chosen) continue;
    placed.set(item.id, chosen);
    const occupied = {
      x: chosen.x - padding,
      y: chosen.y - padding,
      width: chosen.width + padding * 2,
      height: chosen.height + padding * 2,
    };
    for (const key of cellKeys(occupied)) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(occupied);
    }
  }
  return placed;
}

export function graphFitTransform(
  nodes,
  width,
  height,
  { padding = 48, nodePadding = 20, minScale = 0.01, maxScale = 1 } = {},
) {
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError("Graph viewport width must be positive");
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new RangeError("Graph viewport height must be positive");
  }

  const positioned = nodes.filter((node) =>
    Number.isFinite(node.x) && Number.isFinite(node.y)
  );
  if (positioned.length === 0) return { x: 0, y: 0, k: 1 };

  const minX = Math.min(...positioned.map((node) => node.x)) - nodePadding;
  const maxX = Math.max(...positioned.map((node) => node.x)) + nodePadding;
  const minY = Math.min(...positioned.map((node) => node.y)) - nodePadding;
  const maxY = Math.max(...positioned.map((node) => node.y)) + nodePadding;
  const safePadding = Math.max(
    0,
    Math.min(padding, width * 0.2, height * 0.2),
  );
  const availableWidth = Math.max(1, width - safePadding * 2);
  const availableHeight = Math.max(1, height - safePadding * 2);
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const k = Math.max(
    minScale,
    Math.min(
      maxScale,
      availableWidth / boundsWidth,
      availableHeight / boundsHeight,
    ),
  );

  return {
    x: width / 2 - k * ((minX + maxX) / 2),
    y: height / 2 - k * ((minY + maxY) / 2),
    k,
  };
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

function normalisedSimilarity(link, range) {
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
  return 130 - 80 * normalisedSimilarity(link, range);
}

export function graphLinkStrength(link, range) {
  if (link.kind === "explicit") return 0.08;
  return 0.22 + 0.58 * normalisedSimilarity(link, range);
}

export function seededGraphRandom(seed = 0x51_7a_2f_19) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
