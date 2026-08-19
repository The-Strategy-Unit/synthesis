import assert from "node:assert/strict";

import {
  graphLinkDistance,
  graphLinkStrength,
  graphFocusNodeIds,
  searchContextGraph,
  seededGraphRandom,
  semanticNeighborLinks,
  semanticSimilarityRange,
} from "./graph_layout.js";

Deno.test("semantic neighbour breadth is local, deterministic, and keeps explicit links", () => {
  const nodes = [1, 2, 3, 4].map((id) => ({ id }));
  const links = [
    { source: 1, target: 4, kind: "explicit" },
    { source: 1, target: 2, kind: "semantic", similarity: 0.9 },
    { source: 1, target: 3, kind: "semantic", similarity: 0.8 },
    { source: 2, target: 3, kind: "semantic", similarity: 0.7 },
    { source: 3, target: 4, kind: "semantic", similarity: 0.6 },
  ];

  assert.deepEqual(semanticNeighborLinks(nodes, links, 0), [links[0]]);
  assert.deepEqual(semanticNeighborLinks(nodes, links, 1), [
    links[0],
    links[1],
    links[2],
    links[4],
  ]);
  assert.throws(
    () => semanticNeighborLinks(nodes, links, -1),
    /must be non-negative/,
  );
});

Deno.test("search context keeps matches, one-hop neighbours, and their induced edges", () => {
  const nodes = [1, 2, 3, 4, 5, 6].map((id) => ({ id }));
  const links = [
    { source: 1, target: 2, kind: "semantic" },
    { source: 1, target: 3, kind: "explicit" },
    { source: 2, target: 3, kind: "semantic" },
    { source: 3, target: 4, kind: "semantic" },
    { source: 5, target: 6, kind: "explicit" },
  ];

  const context = searchContextGraph(nodes, links, new Set([1, 99]));
  assert.deepEqual(context.nodes, nodes.slice(0, 3));
  assert.deepEqual(context.links, links.slice(0, 3));
  assert.deepEqual(context.matchedIds, new Set([1]));

  assert.deepEqual(searchContextGraph(nodes, links, new Set()), {
    nodes: [],
    links: [],
    matchedIds: new Set(),
  });
});

Deno.test("graph focus contains only the selected node and its visible neighbours", () => {
  const nodes = [1, 2, 3, 4].map((id) => ({ id }));
  const links = [
    { source: 1, target: 2 },
    { source: { id: 3 }, target: { id: 1 } },
    { source: 3, target: 4 },
  ];

  assert.deepEqual(graphFocusNodeIds(nodes, links, 1), new Set([1, 2, 3]));
  assert.deepEqual(graphFocusNodeIds(nodes, links, 99), new Set());
});

Deno.test("stronger semantic links pull closer and more strongly", () => {
  const weak = { kind: "semantic", similarity: 0.4 };
  const strong = { kind: "semantic", similarity: 0.8 };
  const range = semanticSimilarityRange([weak, strong]);
  assert.deepEqual(range, { min: 0.4, max: 0.8 });
  assert.ok(graphLinkDistance(strong, range) < graphLinkDistance(weak, range));
  assert.ok(graphLinkStrength(strong, range) > graphLinkStrength(weak, range));
  assert.equal(graphLinkDistance({ kind: "explicit" }, range), 105);
  assert.equal(graphLinkStrength({ kind: "explicit" }, range), 0.08);
});

Deno.test("graph random source is reproducible", () => {
  const first = seededGraphRandom();
  const second = seededGraphRandom();
  assert.deepEqual(
    [first(), first(), first(), first()],
    [second(), second(), second(), second()],
  );
});
