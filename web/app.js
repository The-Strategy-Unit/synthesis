import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom } from "d3-zoom";

// --- Search input ---
function setSearchStatus(text) {
  const input = document.getElementById("search-input");
  input.style.background = text
    ? "linear-gradient(90deg, #1a4a7a 0%, #0f3460 100%)"
    : "";
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
let simulation = null;

// --- Note list ---

async function loadNoteList() {
  const data = await api("notes");
  currentNotes = data.notes ?? [];
  const list = document.getElementById("note-list");
  list.innerHTML = "";
  for (const note of currentNotes) {
    const li = document.createElement("li");
    li.textContent = note.title;
    li.dataset.id = note.id;
    li.addEventListener("click", () => loadNote(note.id, li));
    list.appendChild(li);
  }
}

// --- Note modal ---

const modal = document.getElementById("note-modal");
const modalClose = document.getElementById("modal-close");

function openModal() {
  modal.classList.remove("hidden");
}
function closeModal() {
  modal.classList.add("hidden");
}

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

async function loadNote(id, liEl) {
  document.querySelectorAll("#note-list li").forEach((el) =>
    el.classList.remove("active")
  );
  if (liEl) liEl.classList.add("active");

  const data = await api(`notes/${encodeURIComponent(id)}`);
  const viewer = document.getElementById("note-content");

  // Strip frontmatter before rendering
  const raw = data.content ?? "";
  const body = raw.replace(/^---[\s\S]*?---\s*/, "");

  const html = body
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");

  viewer.innerHTML = html;
  openModal();
}

// --- Search ---

let searchTimeout;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 2) {
    loadNoteList();
    return;
  }
  setSearchStatus("searching...");
  searchTimeout = setTimeout(async () => {
    const mode = document.getElementById("search-mode").value;
    const data = await api(`search?q=${encodeURIComponent(q)}&mode=${mode}`);
    setSearchStatus("");
    const list = document.getElementById("note-list");
    list.innerHTML = "";
    for (const result of data.results ?? []) {
      const li = document.createElement("li");
      li.textContent = result.title;
      li.dataset.id = result.id;
      li.addEventListener("click", () => loadNote(result.id, li));
      list.appendChild(li);
    }
  }, 800);
});

// --- Ingest ---

document.getElementById("ingest-btn").addEventListener("click", async () => {
  const input = document.getElementById("ingest-input");
  const status = document.getElementById("ingest-status");
  const source = input.value.trim();
  if (!source) return;

  status.textContent = "Ingesting...";
  input.disabled = true;
  document.getElementById("ingest-btn").disabled = true;

  try {
    const isPlaylist = source.includes("list=");
    const endpoint = isPlaylist ? "ingest/playlist" : "ingest";
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ url: source }),
    });

    if (data.error) {
      status.textContent = `Error: ${data.error}`;
    } else {
      status.textContent = `Done! ${data.notes.length} notes created.`;
      await loadNoteList();
      await loadGraph();
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    input.disabled = false;
    document.getElementById("ingest-btn").disabled = false;
    input.value = "";
  }
});

// Enter key triggers ingest too
document.getElementById("ingest-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("ingest-btn").click();
});

// --- Graph (d3-force) ---

async function loadGraph() {
  const data = await api("graph");
  graphData = { nodes: data.nodes ?? [], links: data.links ?? [] };
  renderGraph();
}

function renderGraph() {
  const svg = select("#graph");
  const panel = document.getElementById("graph-panel");
  const width = panel.clientWidth - 10;
  const height = panel.clientHeight - 40;
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  svg.selectAll("*").remove();

  if (graphData.nodes.length === 0) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#555")
      .attr("font-size", "12px")
      .text("No notes yet");
    return;
  }

  const g = svg.append("g");

  svg.call(
    zoom()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => g.attr("transform", event.transform)),
  );

  const link = g.append("g")
    .attr("stroke", "#6a7a8a")
    .attr("stroke-opacity", 0.7)
    .selectAll("line")
    .data(graphData.links)
    .join("line")
    .attr("stroke-width", 1.5);

  const node = g.append("g")
    .selectAll("circle")
    .data(graphData.nodes)
    .join("circle")
    .attr("r", 8)
    .attr("fill", "#4ea8de")
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer")
    .on("click", (_event, d) => loadNote(d.id));

  const label = g.append("g")
    .selectAll("text")
    .data(graphData.nodes)
    .join("text")
    .text((d) => d.title.length > 20 ? d.title.slice(0, 17) + "…" : d.title)
    .attr("font-size", "10px")
    .attr("fill", "#ccc")
    .attr("dx", 10)
    .attr("dy", 3)
    .style("pointer-events", "none");

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

// --- Init ---

loadNoteList();
loadGraph();
globalThis.addEventListener("resize", () => {
  if (simulation) renderGraph();
});
