import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom } from "d3-zoom";

// --- Config (fetched from backend) ---

let uiConfig = {
  labelZoomThreshold: 1.5,
  sliderMin: 0,
  sliderMax: 1,
  sliderStep: 0.025,
  defaultSimilarity: 0.75,
};

async function fetchConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      uiConfig = { ...uiConfig, ...data };
    }
  } catch {
    // Use defaults if endpoint not available
  }
  applyConfig();
}

function applyConfig() {
  const slider = document.getElementById("similarity-slider");
  slider.min = uiConfig.sliderMin;
  slider.max = uiConfig.sliderMax;
  slider.step = uiConfig.sliderStep;
  slider.value = uiConfig.defaultSimilarity;
  document.getElementById("threshold-value").textContent = uiConfig
    .defaultSimilarity.toFixed(2);
}

// --- API helpers ---

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

// --- State ---

let currentNotes = [];
let graphData = { nodes: [], links: [] };
let rawGraphData = { nodes: [], links: [] };
let simulation = null;

// --- Note list ---

async function loadNoteList() {
  const data = await api("notes");
  currentNotes = data.notes ?? [];
  const list = document.getElementById("note-list");
  list.innerHTML = "";

  const groups = new Map();
  for (const note of currentNotes) {
    const key = note.source_url || "Text notes";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }

  for (const [source, notes] of groups) {
    const li = document.createElement("li");
    li.className = "tree-group";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = "▸ " + (notes[0].title?.split(" — ")[0] || source);
    label.style.cursor = "pointer";
    li.appendChild(label);

    const ul = document.createElement("ul");
    ul.className = "tree-children";
    ul.style.display = "none";

    label.addEventListener("click", () => {
      const open = ul.style.display !== "none";
      ul.style.display = open ? "none" : "block";
      label.textContent = (open ? "▸ " : "▾ ") + label.textContent.slice(2);
    });

    for (const note of notes) {
      const child = document.createElement("li");
      child.textContent = note.title;
      child.dataset.id = note.id;
      child.addEventListener("click", () => loadNote(note.id, child));
      ul.appendChild(child);
    }
    li.appendChild(ul);
    list.appendChild(li);
  }
}

// --- Note modal ---

const modal = document.getElementById("note-modal");
const modalClose = document.getElementById("modal-close");

function openModal() {
  modal.classList.remove("hidden");
}
function closeModal(updateHistory = true) {
  modal.classList.add("hidden");
  if (updateHistory) {
    const url = new URL(location.href);
    if (url.searchParams.has("note")) {
      url.searchParams.delete("note");
      history.replaceState({}, "", url);
    }
  }
}

modalClose.addEventListener("click", () => closeModal());
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadNote(id, liEl, updateHistory = true) {
  if (updateHistory) {
    const url = new URL(location.href);
    if (url.searchParams.get("note") !== String(id)) {
      url.searchParams.set("note", String(id));
      history.pushState({}, "", url);
    }
  }
  document.querySelectorAll("#note-list li").forEach((el) =>
    el.classList.remove("active")
  );
  if (liEl) liEl.classList.add("active");

  const data = await api(`notes/${encodeURIComponent(id)}`);
  const viewer = document.getElementById("note-content");

  const raw = data.content ?? "";
  const body = raw.replace(/^---[\s\S]*?---\s*/, "");

  const html = escapeHtml(body)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");

  let relatedHtml = "";
  if (data.related && data.related.length > 0) {
    relatedHtml = '<hr style="border-color:#333;margin:1rem 0">' +
      '<p style="color:#888;font-size:0.8rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.5rem">Related</p>' +
      '<ul style="list-style:none">' +
      data.related.map((r) =>
        `<li><a href="/?note=${encodeURIComponent(r.id)}" data-id="${r.id}" class="related-link">${
          escapeHtml(r.title)
        }</a></li>`
      ).join("") +
      "</ul>";
  }

  viewer.innerHTML = html + relatedHtml;

  viewer.querySelectorAll(".related-link").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey ||
        event.altKey
      ) return;
      event.preventDefault();
      const relId = parseInt(el.dataset.id);
      loadNote(relId);
    });
  });

  openModal();
}

// --- Search ---

const searchInput = document.getElementById("search-input");
const searchMode = document.getElementById("search-mode");

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = e.target.value.trim();
    if (q.length < 2) return;
    doSearch(q);
  }
  if (e.key === "Escape") {
    e.target.value = "";
    loadNoteList();
  }
});

async function doSearch(q) {
  const mode = searchMode.value;
  const list = document.getElementById("note-list");

  list.innerHTML =
    '<li style="color:#7a7f94;font-style:italic">Searching...</li>';
  searchInput.disabled = true;
  searchMode.disabled = true;

  try {
    const data = await api(`search?q=${encodeURIComponent(q)}&mode=${mode}`);
    list.innerHTML = "";
    for (const result of data.results ?? []) {
      const li = document.createElement("li");
      li.textContent = result.title;
      li.dataset.id = result.id;
      li.addEventListener("click", () => loadNote(result.id, li));
      list.appendChild(li);
    }
    if (list.children.length === 0) {
      list.innerHTML =
        '<li style="color:#7a7f94;font-style:italic">No results</li>';
    }
  } catch (err) {
    list.innerHTML =
      `<li style="color:#ff6b6b">Search error: ${err.message}</li>`;
  } finally {
    searchInput.disabled = false;
    searchMode.disabled = false;
  }
}

// --- Ingest with SSE progress ---

document.getElementById("ingest-btn").addEventListener("click", async () => {
  const input = document.getElementById("ingest-input");
  const status = document.getElementById("ingest-status");
  const source = input.value.trim();
  if (!source) return;

  input.disabled = true;
  document.getElementById("ingest-btn").disabled = true;

  const isPlaylist = source.includes("list=");
  const endpoint = isPlaylist ? "/api/ingest/playlist" : "/api/ingest";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: source }),
    });

    if (!res.body) throw new Error("No response stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        const labels = {
          ingesting: "⬇️ Downloading subtitles...",
          ingested: "📝 Transcript ready",
          extracting: "🧠 Extracting insights...",
          distilling: `🧠 ${data.title}`,
          distilled: "✨ Notes distilled",
          integrating: "🔗 Integrating with wiki...",
          integrated:
            `🔗 Integrated (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)`,
          embedding: "📐 Embedding notes...",
          linking: "🕸️ Computing connections...",
          done: `✅ Done! ${data.notes?.length ?? 0} notes saved.`,
          error: `❌ ${data.error}`,
        };
        status.textContent = labels[data.stage] ?? data.stage;
        if (data.stage === "done" || data.stage === "error") {
          if (data.stage === "done") {
            await loadNoteList();
            await loadGraph();
          }
        }
      }
    }
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
  } finally {
    input.disabled = false;
    document.getElementById("ingest-btn").disabled = false;
    input.value = "";
  }
});

document.getElementById("ingest-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("ingest-btn").click();
});

// --- Graph (d3-force) ---

async function loadGraph() {
  const data = await api("graph");
  rawGraphData = {
    nodes: data.nodes ?? [],
    links: (data.links ?? []).map((l) => ({
      source: l.source,
      target: l.target,
      similarity: l.similarity,
    })),
  };
  graphData = JSON.parse(JSON.stringify(rawGraphData));
  const nodeIds = new Set(graphData.nodes.map((n) => n.id));
  graphData.links = graphData.links.filter((l) => {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    return nodeIds.has(s) && nodeIds.has(t);
  });

  renderGraph();
}

const tooltip = select("#graph-tooltip");

function renderGraph() {
  const svg = select("#graph");
  const panel = document.getElementById("graph-panel");
  const width = panel.clientWidth - 10;
  const height = panel.clientHeight || panel.parentElement.clientHeight;
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();

  if (graphData.nodes.length === 0) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("class", "placeholder-text")
      .text("No notes yet");
    return;
  }

  const g = svg.append("g");
  let currentZoom = 1;
  const sims = graphData.links.map((l) => l.similarity ?? 0.6);
  const minSim = sims.length ? Math.min(...sims) : 0.6;
  const maxSim = sims.length ? Math.max(...sims) : 0.6;

  svg.call(
    zoom()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        currentZoom = event.transform.k;
        g.attr("transform", event.transform);
        const showLabels = currentZoom > uiConfig.labelZoomThreshold;
        label.style("display", showLabels ? null : "none");
        if (showLabels) tooltip.classed("hidden", true);
      }),
  );

  const link = g.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(graphData.links)
    .join("line")
    .attr("class", "link")
    .attr("stroke", (d) => {
      const sim = d.similarity ?? 0.6;
      const t = (sim - minSim) / ((maxSim - minSim) || 1);
      const r = Math.round(130 - 50 * t);
      const gg = Math.round(140 - 50 * t);
      const b = Math.round(155 + 45 * t);
      return `rgb(${r}, ${gg}, ${b})`;
    })
    .attr("stroke-width", (d) => {
      const sim = d.similarity ?? 0.6;
      return 1.0 + 2.0 * ((sim - minSim) / ((maxSim - minSim) || 1));
    })
    .attr("stroke-opacity", (d) => {
      const sim = d.similarity ?? 0.6;
      return 0.28 + 0.50 * ((sim - minSim) / ((maxSim - minSim) || 1));
    });

  const degree = new Map();
  for (const n of graphData.nodes) degree.set(n.id, 0);
  for (const l of graphData.links) {
    degree.set(
      l.source.id ?? l.source,
      (degree.get(l.source.id ?? l.source) ?? 0) + 1,
    );
    degree.set(
      l.target.id ?? l.target,
      (degree.get(l.target.id ?? l.target) ?? 0) + 1,
    );
  }

  function nodeRadius(d) {
    const ddeg = degree.get(d.id) ?? 0;
    return Math.min(14, Math.max(6, 6 + Math.sqrt(ddeg) * 1.5));
  }

  const node = g.append("g")
    .selectAll("circle")
    .data(graphData.nodes)
    .join("circle")
    .attr("class", "node")
    .attr("r", nodeRadius)
    .style("cursor", "pointer")
    .on("click", (_event, d) => loadNote(d.id))
    .on("mouseover", (event, d) => {
      highlightNeighborhood(d.id);
      const visibleConnections = degree.get(d.id) ?? 0;
      tooltip
        .classed("hidden", false)
        .text(`${d.title} — ${visibleConnections} visible connections`);
    })
    .on("mousemove", (event) => {
      tooltip
        .style("left", `${event.clientX + 12}px`)
        .style("top", `${event.clientY - 10}px`);
    })
    .on("mouseout", () => {
      clearNeighborhoodHighlight();
      tooltip.classed("hidden", true);
    });

  const label = g.append("g")
    .selectAll("text")
    .data(graphData.nodes)
    .join("text")
    .attr("class", "label")
    .text((d) => d.title.length > 20 ? d.title.slice(0, 17) + "…" : d.title)
    .attr("dx", 10)
    .attr("dy", 3)
    .style("pointer-events", "none");

  function endpointId(endpoint) {
    return endpoint && typeof endpoint === "object" ? endpoint.id : endpoint;
  }

  function highlightNeighborhood(hoveredId) {
    const connectedIds = new Set([hoveredId]);
    link.each((edge) => {
      const sourceId = endpointId(edge.source);
      const targetId = endpointId(edge.target);
      if (sourceId === hoveredId) connectedIds.add(targetId);
      if (targetId === hoveredId) connectedIds.add(sourceId);
    });

    link
      .classed("is-highlighted", (edge) =>
        endpointId(edge.source) === hoveredId ||
        endpointId(edge.target) === hoveredId
      )
      .classed("is-muted", (edge) =>
        endpointId(edge.source) !== hoveredId &&
        endpointId(edge.target) !== hoveredId
      );
    node
      .classed("is-focused", (datum) => datum.id === hoveredId)
      .classed(
        "is-connected",
        (datum) => datum.id !== hoveredId && connectedIds.has(datum.id),
      )
      .classed("is-muted", (datum) => !connectedIds.has(datum.id));
    label
      .classed("is-highlighted", (datum) => connectedIds.has(datum.id))
      .classed("is-muted", (datum) => !connectedIds.has(datum.id));
  }

  function clearNeighborhoodHighlight() {
    link.classed("is-highlighted is-muted", false);
    node.classed("is-focused is-connected is-muted", false);
    label.classed("is-highlighted is-muted", false);
  }

  node.call(
    drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }),
  );

  simulation = forceSimulation(graphData.nodes)
    .force("link", forceLink(graphData.links).id((d) => d.id).distance(80))
    .force("charge", forceManyBody().strength(-300))
    .force("center", forceCenter(width / 2, height / 2))
    .on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      node
        .attr("cx", (d) => d.x)
        .attr("cy", (d) => d.y);
      label
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y);
    });
}

// --- Similarity threshold slider ---

const slider = document.getElementById("similarity-slider");
const thresholdLabel = document.getElementById("threshold-value");

slider.addEventListener("input", () => {
  const threshold = parseFloat(slider.value);
  thresholdLabel.textContent = threshold.toFixed(2);
  renderGraphFiltered(threshold);
});

function renderGraphFiltered(threshold) {
  const filteredLinks = rawGraphData.links
    .filter((l) => (l.similarity ?? 0.6) >= threshold)
    .map((l) => ({
      source: l.source,
      target: l.target,
      similarity: l.similarity,
    }));

  const connectedIds = new Set();
  for (const l of filteredLinks) {
    connectedIds.add(l.source);
    connectedIds.add(l.target);
  }

  const filteredNodes = rawGraphData.nodes
    .filter((n) => connectedIds.has(n.id))
    .map((n) => ({ id: n.id, title: n.title }));

  graphData = { nodes: filteredNodes, links: filteredLinks };
  renderGraph();
}

// --- Init ---

await fetchConfig();
await loadNoteList();
await loadGraph();
const requestedNoteId = Number(new URLSearchParams(location.search).get("note"));
if (Number.isSafeInteger(requestedNoteId) && requestedNoteId > 0) {
  await loadNote(requestedNoteId, undefined, false);
}
globalThis.addEventListener("popstate", () => {
  const noteId = Number(new URLSearchParams(location.search).get("note"));
  if (Number.isSafeInteger(noteId) && noteId > 0) {
    loadNote(noteId, undefined, false);
  } else closeModal(false);
});
globalThis.addEventListener("resize", () => {
  if (simulation) renderGraph();
});
