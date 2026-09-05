import assert from "node:assert/strict";

import {
  graphFitTransform,
  graphFocusNodeIds,
  graphLabelLayout,
  graphLabelLines,
  graphLinkDistance,
  graphLinkStrength,
  graphNeighbourRows,
  searchContextGraph,
  seededGraphRandom,
  semanticNeighbourLinks,
  semanticSimilarityRange,
} from "./graph_layout.js";

function labelCandidate(id, x, y, priority = 4) {
  return { id, x, y, width: 100, height: 32, radius: 8, priority, degree: 0 };
}

Deno.test("overview labels remain visible, spaced and deterministic", () => {
  const candidates = [labelCandidate(1, 60, 90), labelCandidate(2, 360, 90)];
  const first = graphLabelLayout(candidates, 600, 240);
  assert.equal(first.size, 2);
  assert.deepEqual(first, graphLabelLayout(candidates, 600, 240));
  const boxes = [...first.values()];
  assert.ok(boxes[0].x + boxes[0].width < boxes[1].x);
});

Deno.test("fitting a wide graph retains labels below the old zoom threshold", () => {
  const nodes = [{ id: 1, x: -1000, y: 0 }, { id: 2, x: 1000, y: 0 }];
  const transform = graphFitTransform(nodes, 800, 400);
  assert.ok(transform.k < 1.5);
  const candidates = nodes.map((node) =>
    labelCandidate(
      node.id,
      node.x * transform.k + transform.x,
      node.y * transform.k + transform.y,
    )
  );
  assert.equal(graphLabelLayout(candidates, 800, 400).size, 2);
});

Deno.test("dense labels prioritise interaction and search over hubs", () => {
  const candidates = Array.from({ length: 30 }, (_, id) => ({
    ...labelCandidate(id, 150, 100),
    degree: 100 - id,
  }));
  candidates[29].priority = 0;
  candidates[28].priority = 2;
  const labels = graphLabelLayout(candidates, 320, 240);
  assert.ok(labels.has(29));
  assert.ok(labels.has(28));
  assert.ok(labels.size < candidates.length);
  const boxes = [...labels.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(
        a.x + a.width <= b.x || b.x + b.width <= a.x ||
          a.y + a.height <= b.y || b.y + b.height <= a.y,
      );
    }
  }
});

Deno.test("label layout rejects offscreen or unsettled nodes and clamps focus", () => {
  const labels = graphLabelLayout(
    [
      labelCandidate(1, -100, 50),
      labelCandidate(2, NaN, 50),
      labelCandidate(3, 318, 238, 1),
    ],
    320,
    240,
  );
  assert.deepEqual([...labels.keys()], [3]);
  const box = labels.get(3);
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.width <= 320 && box.y + box.height <= 240);
  assert.equal(graphLabelLayout([], 0, 0).size, 0);
});

Deno.test("stable labels retain priority over equivalent new candidates", () => {
  const candidates = [labelCandidate(1, 150, 100), labelCandidate(2, 150, 100)];
  const labels = graphLabelLayout(candidates, 320, 240, {
    previousIds: new Set([2]),
  });
  assert.equal([...labels.keys()][0], 2);
});

Deno.test("labels wrap meaningful words and bound very long titles", () => {
  const measure = (text) => [...text].length * 8;
  assert.deepEqual(graphLabelLines("Blood pressure targets", measure, 120), [
    "Blood pressure",
    "targets",
  ]);
  const lines = graphLabelLines("A".repeat(1000), measure, 120);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
  assert.ok(lines.every((line) => measure(line) <= 120));
  assert.deepEqual(graphLabelLines("   ", measure, 120), ["Untitled page"]);
});

Deno.test("neighbour list deduplicates edges and preserves both link kinds", () => {
  const nodes = [{ id: 1, title: "Focus" }, { id: 2, title: "Zulu" }, {
    id: 3,
    title: "Alpha",
  }, { id: 4, title: "Unconnected" }];
  const links = [
    { source: 1, target: 2, kind: "semantic" },
    { source: { id: 2 }, target: { id: 1 }, kind: "explicit" },
    { source: 3, target: 1, kind: "semantic" },
    { source: 1, target: 99, kind: "explicit" },
    { source: 1, target: 1, kind: "explicit" },
  ];
  assert.deepEqual(graphNeighbourRows(nodes, links, 1), [
    { id: 2, title: "Zulu", kinds: ["explicit", "semantic"] },
    { id: 3, title: "Alpha", kinds: ["semantic"] },
  ]);
  assert.deepEqual(graphNeighbourRows(nodes, links, 99), []);
  assert.deepEqual(graphNeighbourRows(nodes, links, 4), []);
});

Deno.test("graph fit transform centres every positioned node with padding", () => {
  const transform = graphFitTransform(
    [{ x: -100, y: -50 }, { x: 100, y: 50 }],
    1000,
    600,
  );

  assert.deepEqual(transform, { x: 500, y: 300, k: 1 });

  const wide = graphFitTransform(
    [{ x: -1000, y: 0 }, { x: 1000, y: 0 }],
    1000,
    600,
  );
  assert.ok(wide.k < 0.5);
  assert.equal(wide.x, 500);
  assert.equal(wide.y, 300);
});

Deno.test("graph fit transform handles missing positions and invalid viewports", () => {
  assert.deepEqual(graphFitTransform([{}], 800, 600), { x: 0, y: 0, k: 1 });
  assert.throws(() => graphFitTransform([], 0, 600), /width must be positive/);
  assert.throws(
    () => graphFitTransform([], 800, -1),
    /height must be positive/,
  );
});

Deno.test("semantic neighbour breadth keeps reviewed links painted last", () => {
  const nodes = [1, 2, 3, 4].map((id) => ({ id }));
  const links = [
    { source: 1, target: 4, kind: "explicit" },
    { source: 1, target: 2, kind: "semantic", similarity: 0.9 },
    { source: 1, target: 3, kind: "semantic", similarity: 0.8 },
    { source: 2, target: 3, kind: "semantic", similarity: 0.7 },
    { source: 3, target: 4, kind: "semantic", similarity: 0.6 },
  ];

  assert.deepEqual(semanticNeighbourLinks(nodes, links, 0), [links[0]]);
  assert.deepEqual(semanticNeighbourLinks(nodes, links, 1), [
    links[1],
    links[2],
    links[4],
    links[0],
  ]);
  assert.equal(semanticNeighbourLinks(nodes, links, 1).at(-1).kind, "explicit");
  assert.throws(
    () => semanticNeighbourLinks(nodes, links, -1),
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
