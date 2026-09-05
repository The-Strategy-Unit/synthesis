import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity } from "d3-zoom";
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
import {
  classifyIngestSource,
  parseTrustedVideoBatch,
  trustedBatchConfirmation,
} from "./ingest_source.js";
import {
  compactEvidenceText,
  evidenceActionLabel,
  evidenceSourceLocation,
  evidenceSummary,
  initialReaderState,
  reduceReaderState,
} from "./reader_workspace.js";
import {
  discoveryBatchConfirmation,
  discoveryCoverageSummary,
  discoveryMatchesFilter,
  formatPageRanges,
  ingestProgress,
  MAX_DISCOVERY_BATCH_ITEMS,
  REVIEW_DECISIONS,
  reviewDecisionsForEveryChange,
  reviewDecisionSummary,
} from "./review_workflow.js";
import {
  ollamaPreset,
  providerCapabilities,
  providerEmptyState,
  providerPresentation,
} from "./provider_readiness.js";
import {
  searchMethodSummary,
  searchResultMetric,
  sortSearchResults,
} from "./search_results.js";
import { buildCompleteSemanticIndex } from "./semantic_index.js";
import { initialShellState, queueBadge, reduceShellState } from "./ui_shell.js";

// --- Config (fetched from backend) ---

let uiConfig = {
  labelZoomThreshold: 1.5,
  semanticNeighbors: 3,
  maxSemanticNeighbors: 8,
};

// --- Application shell ---

const addSourceButton = document.getElementById("add-source-btn");
const sourcePanel = document.getElementById("source-panel");
const sourcePanelClose = document.getElementById("source-panel-close");
const navigationToggle = document.getElementById("nav-toggle");
const primaryNavigation = document.getElementById("primary-nav");
const vaultTools = document.getElementById("vault-tools");
const vaultMenuButton = document.getElementById("vault-menu-btn");
const vaultMenu = document.getElementById("vault-menu");
let shellState = initialShellState();

function renderShell() {
  sourcePanel.classList.toggle("hidden", !shellState.sourceOpen);
  addSourceButton.setAttribute("aria-expanded", String(shellState.sourceOpen));
  vaultMenu.classList.toggle("hidden", !shellState.toolsOpen);
  vaultMenuButton.setAttribute("aria-expanded", String(shellState.toolsOpen));
  primaryNavigation.classList.toggle("is-open", shellState.navigationOpen);
  navigationToggle.setAttribute(
    "aria-expanded",
    String(shellState.navigationOpen),
  );
  navigationToggle.setAttribute(
    "aria-label",
    shellState.navigationOpen ? "Close navigation" : "Open navigation",
  );
}

function updateShell(action) {
  shellState = reduceShellState(shellState, action);
  renderShell();
}

function setShellQueueCount(id, count, singular, plural) {
  const badge = document.getElementById(id);
  const presentation = queueBadge(count, singular, plural);
  badge.textContent = presentation.text;
  badge.setAttribute("aria-label", presentation.label);
  badge.classList.toggle("hidden", presentation.hidden);
}

addSourceButton.addEventListener("click", () => {
  updateShell({ type: "toggle-source" });
  if (shellState.sourceOpen) {
    queueMicrotask(() => document.getElementById("ingest-input").focus());
  }
});

sourcePanelClose.addEventListener("click", () => {
  updateShell({ type: "close-source" });
  addSourceButton.focus();
});

navigationToggle.addEventListener("click", () => {
  updateShell({ type: "toggle-navigation" });
});

primaryNavigation.addEventListener("click", (event) => {
  if (event.target.closest(".nav-item")) {
    updateShell({ type: "dismiss" });
  }
});

vaultMenuButton.addEventListener("click", () => {
  updateShell({ type: "toggle-tools" });
  if (shellState.toolsOpen) {
    queueMicrotask(() => vaultMenu.querySelector("button, a")?.focus());
  }
});

vaultMenu.addEventListener("click", () => {
  updateShell({ type: "close-tools" });
});

document.addEventListener("click", (event) => {
  if (shellState.toolsOpen && !vaultTools.contains(event.target)) {
    updateShell({ type: "close-tools" });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (shellState.sourceOpen) {
    updateShell({ type: "close-source" });
    addSourceButton.focus();
  } else if (shellState.toolsOpen) {
    updateShell({ type: "close-tools" });
    vaultMenuButton.focus();
  } else if (shellState.navigationOpen) {
    updateShell({ type: "close-navigation" });
    navigationToggle.focus();
  }
});

renderShell();

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
  const slider = document.getElementById("semantic-neighbours-slider");
  slider.max = uiConfig.maxSemanticNeighbors;
  slider.value = Math.min(
    uiConfig.semanticNeighbors,
    uiConfig.maxSemanticNeighbors,
  );
  document.getElementById("semantic-neighbours-value").textContent =
    slider.value;
}

// --- API helpers ---

const operationFeedback = document.getElementById("operation-feedback");
const operationFeedbackLabel = document.getElementById(
  "operation-feedback-label",
);
const activeOperations = new Map();
const activeStatusOperations = new WeakMap();

function renderOperationFeedback() {
  const operations = [...activeOperations.values()];
  const current =
    [...operations].reverse().find((operation) => operation.specific) ??
      operations.at(-1);
  operationFeedback.classList.toggle("hidden", !current);
  operationFeedback.setAttribute("aria-busy", String(Boolean(current)));
  if (current) operationFeedbackLabel.textContent = current.message;
}

function beginOperation(message, status) {
  const token = Symbol("operation");
  activeOperations.set(token, {
    message: message ?? "Synthesis is working…",
    specific: Boolean(message),
  });
  if (status) {
    const count = (activeStatusOperations.get(status) ?? 0) + 1;
    activeStatusOperations.set(status, count);
    status.classList.add("operation-active");
    status.setAttribute("aria-busy", "true");
  }
  renderOperationFeedback();

  return () => {
    activeOperations.delete(token);
    if (status) {
      const count = Math.max(
        0,
        (activeStatusOperations.get(status) ?? 1) - 1,
      );
      if (count === 0) {
        activeStatusOperations.delete(status);
        status.classList.remove("operation-active");
        status.setAttribute("aria-busy", "false");
      } else activeStatusOperations.set(status, count);
    }
    renderOperationFeedback();
  };
}

async function api(path, opts = {}) {
  const { progress, ...fetchOptions } = opts;
  const finishOperation = beginOperation(
    progress?.message,
    progress?.status,
  );
  try {
    const res = await fetch(`/api/${path}`, {
      headers: { "Content-Type": "application/json" },
      ...fetchOptions,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `Request failed (${res.status})`);
      error.code = data.code;
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    finishOperation();
  }
}

function showModalDialog(dialog, initialFocus) {
  if (dialog.open) return;
  dialog.showModal();
  initialFocus?.focus({ preventScroll: true });
}

function closeModalDialog(dialog) {
  if (dialog.open) dialog.close();
}

function bindModalDismissal(dialog, dismiss) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
}

async function refreshShellCounts() {
  const [reviews, discoveries] = await Promise.allSettled([
    api("proposals"),
    api("discoveries"),
  ]);
  if (reviews.status === "fulfilled") {
    setShellQueueCount(
      "review-count",
      reviews.value.proposals?.length ?? 0,
      "pending review",
      "pending reviews",
    );
  }
  if (discoveries.status === "fulfilled") {
    setShellQueueCount(
      "discoveries-count",
      discoveries.value.discoveries?.length ?? 0,
      "open synthesis proposal",
      "open synthesis proposals",
    );
  }
}

async function consumeSse(response, onEvent) {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("No response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeBlock = async (block) => {
    const line = block.split("\n").find((line) => line.startsWith("data: "));
    if (!line) return;
    await onEvent(JSON.parse(line.slice(6)));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) await consumeBlock(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) await consumeBlock(buffer);
}

const rebuildCatalogueButton = document.getElementById(
  "rebuild-catalogue-btn",
);
const rebuildSemanticButton = document.getElementById("rebuild-semantic-btn");
let semanticRebuildActive = false;
let semanticRebuildStopRequested = false;

function renderSemanticRebuildButton() {
  if (semanticRebuildActive) {
    rebuildSemanticButton.disabled = semanticRebuildStopRequested;
    rebuildSemanticButton.textContent = semanticRebuildStopRequested
      ? "Stopping after current batch..."
      : "Stop after current batch";
    rebuildSemanticButton.title = semanticRebuildStopRequested
      ? "Semantic indexing will stop when the current bounded batch finishes"
      : "Stop semantic indexing after the current bounded batch";
    return;
  }

  const semanticIndex = providerState.semanticIndex;
  rebuildSemanticButton.disabled = !providerCapabilities(
    providerState.phase,
    semanticIndex,
  ).modelActions;
  rebuildSemanticButton.textContent = semanticIndex?.complete
    ? "Semantic index ready"
    : semanticIndex?.embedded > 0
    ? "Resume semantic index"
    : "Build semantic index";
  rebuildSemanticButton.title = semanticIndex?.complete
    ? "Semantic search and connection state cover the whole wiki"
    : "Build or resume semantic search and connection state for the whole wiki";
}

async function rebuildCatalogue() {
  const confirmed = globalThis.confirm(
    "Rebuild the local catalogue from authoritative vault files? " +
      "Accepted Markdown and sources stay intact. Embeddings, semantic " +
      "connections, pending proposals, and discovery review state are reset.",
  );
  if (!confirmed) return;

  rebuildCatalogueButton.disabled = true;
  rebuildCatalogueButton.textContent = "Rebuilding...";
  const finishOperation = beginOperation(
    "Rebuilding the vault catalogue…",
  );
  try {
    const data = await api("rebuild", {
      method: "POST",
      body: JSON.stringify({ confirm: "REBUILD" }),
    });
    await Promise.all([loadNoteList(), loadGraph()]);
    globalThis.alert(
      `Rebuilt ${data.rebuild.noteCount} wiki pages from ` +
        `${data.rebuild.sourceCount} sources. Keyword search and explicit ` +
        "wiki links are ready. Use Build semantic index to restore semantic search and proximity suggestions.",
    );
  } catch (error) {
    globalThis.alert(error.message);
  } finally {
    finishOperation();
    rebuildCatalogueButton.disabled = false;
    rebuildCatalogueButton.textContent = "Rebuild";
  }
}

rebuildCatalogueButton.addEventListener("click", rebuildCatalogue);

async function rebuildSemanticIndex() {
  if (semanticRebuildActive) {
    semanticRebuildStopRequested = true;
    renderSemanticRebuildButton();
    return;
  }

  const confirmed = globalThis.confirm(
    "Build or resume the semantic index for the whole wiki using the explicitly configured embedding provider? Relevant wiki text will be sent to that provider. Synthesis works in safe batches of up to 20 pages; use Stop after current batch to pause.",
  );
  if (!confirmed) return;

  semanticRebuildActive = true;
  semanticRebuildStopRequested = false;
  renderSemanticRebuildButton();
  const finishOperation = beginOperation(
    "Building the semantic index…",
  );
  try {
    const result = await buildCompleteSemanticIndex(async (limit) => {
      const current = providerState.semanticIndex;
      const progress = current?.total > 0
        ? `Indexed ${current.embedded} of ${current.total} wiki pages; continuing…`
        : "Building the semantic index…";
      const data = await api("semantic-index/rebuild", {
        method: "POST",
        body: JSON.stringify({
          confirm: "REBUILD SEMANTIC INDEX",
          limit,
        }),
        progress: { message: progress },
      });
      return data.semanticIndex;
    }, {
      shouldStop: () => semanticRebuildStopRequested,
      onProgress: (status) => {
        providerState = { ...providerState, semanticIndex: status };
      },
    });
    const status = result.status;
    await Promise.all([refreshProviderMode(), loadGraph()]);
    globalThis.alert(
      status.complete
        ? `Semantic index ready for ${status.total} wiki pages; ${status.links} mutual proximity links were rebuilt.`
        : `Stopped safely after indexing ${status.embedded} of ${status.total} wiki pages. Choose Resume semantic index to continue with the remaining ${status.remaining}.`,
    );
  } catch (error) {
    globalThis.alert(error.message);
  } finally {
    finishOperation();
    semanticRebuildActive = false;
    semanticRebuildStopRequested = false;
    renderSemanticRebuildButton();
  }
}

rebuildSemanticButton.addEventListener("click", rebuildSemanticIndex);

const undoIngestButton = document.getElementById("undo-ingest-btn");

async function undoIngest() {
  const confirmed = globalThis.confirm(
    "Undo the latest accepted ingest? Pages it created will leave the live " +
      "wiki and pages it changed will return to their prior revisions. " +
      "Immutable sources and revision history are retained.",
  );
  if (!confirmed) return;

  undoIngestButton.disabled = true;
  undoIngestButton.textContent = "Undoing...";
  const finishOperation = beginOperation("Undoing the latest ingest…");
  try {
    const data = await api("ingest/undo", {
      method: "POST",
      body: JSON.stringify({ confirm: "UNDO" }),
    });
    await Promise.all([loadNoteList(), loadGraph()]);
    const indexWarning = data.undo.indexUpdated
      ? ""
      : " The wiki index could not be refreshed; use Rebuild.";
    globalThis.alert(
      `Undid “${data.undo.sourceTitle}”: restored ` +
        `${data.undo.restoredCount} and removed ${data.undo.removedCount} ` +
        `live wiki pages.${indexWarning}`,
    );
  } catch (error) {
    globalThis.alert(error.message);
  } finally {
    finishOperation();
    undoIngestButton.disabled = false;
    undoIngestButton.textContent = "Undo ingest";
  }
}

undoIngestButton.addEventListener("click", undoIngest);

// --- State ---

let currentNotes = [];
let graphData = { nodes: [], links: [] };
let rawGraphData = { nodes: [], links: [] };
let graphSearch = null;
let graphFocusId = null;
let graphMaximized = false;
let graphAutoFitPending = false;
let fitGraphToViewport = () => {};
let refreshGraphFocusHighlight = () => {};
let refreshGraphPositions = () => {};
let revealGraphNode = (_id) => {};
let simulation = null;
let graphUnavailable = false;

// --- Note list ---

async function loadNoteList() {
  const data = await api("notes");
  currentNotes = data.notes ?? [];
  const list = document.getElementById("note-list");
  const pageCount = document.getElementById("page-count");
  document.getElementById("note-list-heading").textContent = "Wiki pages";
  const searchMethod = document.getElementById("search-method");
  searchMethod.textContent = "";
  searchMethod.classList.add("hidden");
  const emptyHeading = readerEmpty.querySelector("h2");
  const emptyCopy = readerEmpty.querySelector("h2 + p");
  const emptyAction = document.getElementById("reader-add-source");
  list.replaceChildren();
  pageCount.textContent = String(currentNotes.length);
  pageCount.setAttribute(
    "aria-label",
    `${currentNotes.length} wiki page${currentNotes.length === 1 ? "" : "s"}`,
  );

  if (currentNotes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "note-list-empty";
    empty.textContent = "No compiled pages yet.";
    list.appendChild(empty);
    emptyHeading.textContent = "Build a source-grounded wiki";
    emptyCopy.textContent =
      "Add a source, review the proposed changes, then read the compiled knowledge here.";
    emptyAction.textContent = "Add your first source";
    return;
  }

  emptyHeading.textContent = "Select a wiki page";
  emptyCopy.textContent =
    "Read the durable synthesis, then inspect its supporting claims, sources, and connections without losing context.";
  emptyAction.textContent = "Add another source";

  const notes = [...currentNotes].sort((a, b) =>
    a.title.localeCompare(b.title)
  );
  for (const note of notes) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-list-button";
    button.dataset.id = String(note.id);
    button.textContent = note.title;
    button.classList.toggle("active", readerState.selectedNoteId === note.id);
    button.addEventListener("click", () => loadNote(note.id, button));
    item.appendChild(button);
    list.appendChild(item);
  }
}

// --- Reader workspace ---

const pageViewButton = document.getElementById("page-view-btn");
const connectionsViewButton = document.getElementById("connections-view-btn");
const readerPanel = document.getElementById("reader-panel");
const readerEmpty = document.getElementById("reader-empty");
const readerAddSourceButton = document.getElementById("reader-add-source");
const noteContent = document.getElementById("note-content");
const evidencePanel = document.getElementById("evidence-panel");
const evidenceContent = document.getElementById("evidence-content");
const evidenceToggle = document.getElementById("evidence-toggle");
const evidenceClose = document.getElementById("evidence-close");
const graphPanel = document.getElementById("graph-panel");
const graphElement = document.getElementById("graph");
const graphMaximizeButton = document.getElementById("graph-maximize");
const graphFitButton = document.getElementById("graph-fit");
const knowledgeLayout = document.getElementById("knowledge-layout");
const workspaceTitle = document.getElementById("workspace-title");
const wikiWorkspace = document.getElementById("wiki-workspace");
const reviewWorkspace = document.getElementById("review-workspace");
const wikiNavigationButton = document.getElementById("wiki-nav-btn");
const reviewNavigationButton = document.getElementById("review-open-btn");
let readerState = initialReaderState();
let primaryWorkspace = "wiki";

const graphMaximizeInertTargets = [
  document.getElementById("topbar"),
  primaryNavigation,
  document.querySelector(".knowledge-toolbar"),
  document.getElementById("sidebar"),
  sourcePanel,
].filter(Boolean);

function resizeGraphViewport() {
  if (
    graphPanel.classList.contains("hidden") || primaryWorkspace !== "wiki" ||
    graphElement.clientWidth <= 0 || graphElement.clientHeight <= 0
  ) return;
  const width = Math.max(graphElement.clientWidth, 1);
  const height = Math.max(graphElement.clientHeight, 1);
  select(graphElement).attr("viewBox", `0 0 ${width} ${height}`);
  if (simulation) {
    simulation
      .force("center", forceCenter(width / 2, height / 2))
      .alpha(0.12);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      simulation.stop().tick();
    } else simulation.restart();
  }
  refreshGraphPositions();
}

function setGraphMaximized(maximized, resize = true) {
  graphMaximized = Boolean(maximized);
  if (!graphMaximized) graphAutoFitPending = false;
  graphPanel.classList.toggle("is-maximized", graphMaximized);
  graphMaximizeButton.setAttribute("aria-pressed", String(graphMaximized));
  graphMaximizeButton.textContent = graphMaximized
    ? "Restore graph"
    : "Maximise graph";
  for (const target of graphMaximizeInertTargets) {
    target.inert = graphMaximized;
  }
  if (graphMaximized) {
    graphPanel.setAttribute("role", "dialog");
    graphPanel.setAttribute("aria-modal", "true");
  } else {
    graphPanel.removeAttribute("role");
    graphPanel.removeAttribute("aria-modal");
  }
  if (resize) requestAnimationFrame(resizeGraphViewport);
}

function renderPrimaryWorkspace() {
  const reviewing = primaryWorkspace === "review";
  wikiWorkspace.classList.toggle("hidden", reviewing);
  reviewWorkspace.classList.toggle("hidden", !reviewing);
  wikiNavigationButton.classList.toggle("active", !reviewing);
  reviewNavigationButton.classList.toggle("active", reviewing);
  if (reviewing) {
    if (graphMaximized) setGraphMaximized(false);
    wikiNavigationButton.removeAttribute("aria-current");
    reviewNavigationButton.setAttribute("aria-current", "page");
    simulation?.stop();
  } else {
    reviewNavigationButton.removeAttribute("aria-current");
    wikiNavigationButton.setAttribute("aria-current", "page");
  }
}

function setPrimaryWorkspace(workspace, updateHistory = true) {
  primaryWorkspace = workspace === "review" ? "review" : "wiki";
  renderPrimaryWorkspace();
  if (!updateHistory) return;
  const url = new URL(location.href);
  if (primaryWorkspace === "review") url.searchParams.set("view", "review");
  else {
    url.searchParams.delete("view");
    url.searchParams.delete("proposal");
  }
  if (url.href !== location.href) history.pushState({}, "", url);
}

function showWikiWorkspace(updateHistory = true) {
  setPrimaryWorkspace("wiki", updateHistory);
  updateReader({ type: "show-page" });
}

function renderReaderWorkspace() {
  const pageVisible = readerState.view === "page";
  const hasSelection = readerState.selectedNoteId !== null;
  const evidenceVisible = pageVisible && hasSelection &&
    readerState.evidenceOpen;

  if (pageVisible && graphMaximized) setGraphMaximized(false);

  readerPanel.classList.toggle("hidden", !pageVisible);
  graphPanel.classList.toggle("hidden", pageVisible);
  readerEmpty.classList.toggle("hidden", hasSelection);
  noteContent.classList.toggle("hidden", !hasSelection);
  evidencePanel.classList.toggle("hidden", !evidenceVisible);
  evidenceToggle.classList.toggle("hidden", !pageVisible || !hasSelection);
  evidenceToggle.setAttribute("aria-expanded", String(evidenceVisible));
  knowledgeLayout.classList.toggle("evidence-hidden", !evidenceVisible);
  knowledgeLayout.classList.toggle("connections-view", !pageVisible);

  pageViewButton.classList.toggle("active", pageVisible);
  pageViewButton.setAttribute("aria-pressed", String(pageVisible));
  connectionsViewButton.classList.toggle("active", !pageVisible);
  connectionsViewButton.setAttribute("aria-pressed", String(!pageVisible));
  workspaceTitle.textContent = pageVisible ? "Compiled wiki" : "Connections";

  if (pageVisible) simulation?.stop();
  else queueMicrotask(renderGraph);
}

function updateReader(action) {
  readerState = reduceReaderState(readerState, action);
  renderReaderWorkspace();
}

function clearReader(updateHistory = true) {
  updateReader({ type: "clear-note" });
  noteContent.replaceChildren();
  evidenceContent.replaceChildren();
  document.querySelectorAll("#note-list [data-id]").forEach((element) => {
    element.classList.remove("active");
  });
  if (updateHistory) {
    const url = new URL(location.href);
    url.searchParams.delete("note");
    history.replaceState({}, "", url);
  }
}

pageViewButton.addEventListener("click", () => {
  updateReader({ type: "show-page" });
});
connectionsViewButton.addEventListener("click", () => {
  graphAutoFitPending = true;
  // The graph is rendered after the maximised class takes effect, so a resize
  // restart here would prematurely cool its initial settling animation.
  setGraphMaximized(true, false);
  updateReader({ type: "show-connections" });
  requestAnimationFrame(() =>
    graphMaximizeButton.focus({ preventScroll: true })
  );
});
graphMaximizeButton.addEventListener("click", () => {
  setGraphMaximized(!graphMaximized);
});
graphFitButton.addEventListener("click", () => {
  graphAutoFitPending = false;
  fitGraphToViewport();
});
evidenceToggle.addEventListener("click", () => {
  updateReader({ type: "toggle-evidence" });
});
evidenceClose.addEventListener("click", () => {
  updateReader({ type: "hide-evidence" });
  evidenceToggle.focus();
});
readerAddSourceButton.addEventListener("click", () => {
  if (providerEmptyState(providerState.phase).action === "add-source") {
    addSourceButton.click();
  } else {
    openProviderModal();
  }
});
wikiNavigationButton.addEventListener("click", () => showWikiWorkspace());

renderReaderWorkspace();
renderPrimaryWorkspace();

// --- Cited wiki query and reviewed write-back ---

const askModal = document.getElementById("ask-modal");
const askInput = document.getElementById("ask-input");
const askSubmit = document.getElementById("ask-submit");
const askSave = document.getElementById("ask-save");
const askStatus = document.getElementById("ask-status");
const askResult = document.getElementById("ask-result");
const askAnswer = document.getElementById("ask-answer");
let reviewedWikiAnswer = null;

function openAskModal() {
  showModalDialog(askModal, askInput);
}

function closeAskModal() {
  closeModalDialog(askModal);
}

function setAskBusy(busy) {
  const modelActions = providerCapabilities(providerState.phase).modelActions;
  askInput.disabled = busy || !modelActions;
  askAnswer.disabled = busy;
  askSubmit.disabled = busy || !modelActions;
  askSave.disabled = busy;
}

function clearReviewedAnswer() {
  reviewedWikiAnswer = null;
  askResult.classList.add("hidden");
  askSave.classList.add("hidden");
  askAnswer.value = "";
  document.getElementById("ask-citations").replaceChildren();
}

function showWikiAnswer(question, data) {
  reviewedWikiAnswer = { question, ...data };
  askAnswer.value = data.answer;
  const citations = document.getElementById("ask-citations");
  citations.replaceChildren();
  for (const citation of data.citations ?? []) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = citation.title;
    button.addEventListener("click", () => loadNote(citation.id));
    item.appendChild(button);
    citations.appendChild(item);
  }
  askResult.classList.remove("hidden");
  askSave.classList.remove("hidden");
}

async function submitWikiQuestion() {
  const question = askInput.value.trim();
  if (!question) return;
  clearReviewedAnswer();
  setAskBusy(true);
  askStatus.textContent = "Reading the compiled wiki...";
  const finishOperation = beginOperation(
    "Reading the compiled wiki with AI…",
    askStatus,
  );
  try {
    const data = await api("query", {
      method: "POST",
      body: JSON.stringify({ question }),
    });
    showWikiAnswer(question, data);
    askStatus.textContent = "Review the answer and citations before saving.";
  } catch (error) {
    askStatus.textContent = error.message;
  } finally {
    finishOperation();
    setAskBusy(false);
  }
}

async function saveReviewedWikiAnswer() {
  if (!reviewedWikiAnswer) return;
  const answer = askAnswer.value.trim();
  if (!answer) {
    askStatus.textContent = "The reviewed synthesis cannot be empty.";
    askAnswer.focus();
    return;
  }
  setAskBusy(true);
  askStatus.textContent = "Saving the reviewed synthesis...";
  const finishOperation = beginOperation(
    "Saving the reviewed synthesis…",
    askStatus,
  );
  try {
    const data = await api("query/save", {
      method: "POST",
      body: JSON.stringify({
        question: reviewedWikiAnswer.question,
        answer,
        citations: reviewedWikiAnswer.citations.map((citation) => citation.id),
        suggestedPage: {
          ...reviewedWikiAnswer.suggestedPage,
          body: answer,
        },
      }),
    });
    askSave.classList.add("hidden");
    askStatus.textContent = `Saved “${data.saved.title}”.`;
    await loadNoteList();
    await loadGraph();
  } catch (error) {
    if (error.code === "PAGE_EXISTS" && error.data?.existingNoteId) {
      askSave.classList.add("hidden");
      askStatus.textContent = "That synthesis page already exists.";
    } else {
      askStatus.textContent = error.message;
    }
  } finally {
    finishOperation();
    setAskBusy(false);
  }
}

document.getElementById("ask-open-btn").addEventListener("click", openAskModal);
document.getElementById("ask-close").addEventListener("click", closeAskModal);
bindModalDismissal(askModal, closeAskModal);
askSubmit.addEventListener("click", submitWikiQuestion);
askSave.addEventListener("click", saveReviewedWikiAnswer);
askInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitWikiQuestion();
  }
});
// --- Ingest proposal review ---

const reviewStatus = document.getElementById("review-status");
const proposalList = document.getElementById("proposal-list");
const proposalDetail = document.getElementById("proposal-detail");
const proposalChanges = document.getElementById("proposal-changes");
const proposalApprove = document.getElementById("proposal-approve");
const proposalIncludeAll = document.getElementById("proposal-include-all");
const proposalReject = document.getElementById("proposal-reject");
const proposalDecisionSummary = document.getElementById(
  "proposal-decision-summary",
);
const proposalSourceInspect = document.getElementById(
  "proposal-source-inspect",
);
let selectedProposalId = null;
let selectedProposalSourceId = null;
let proposalBusy = false;

function proposalDecisions() {
  return [...proposalChanges.querySelectorAll(".proposal-change-decision")]
    .map((control) => control.value);
}

function selectedProposalChanges() {
  return [...proposalChanges.querySelectorAll(".proposal-change")].flatMap(
    (item) => {
      const decision = item.querySelector(".proposal-change-decision");
      const body = item.querySelector(".proposal-body-edit");
      if (decision?.value !== REVIEW_DECISIONS.include || !body) return [];
      return [{ index: Number(item.dataset.changeIndex), body: body.value }];
    },
  );
}

function updateProposalApprovalControls() {
  const decisions = proposalDecisions();
  const summary = reviewDecisionSummary(decisions);
  const modelActions = providerCapabilities(providerState.phase).modelActions;
  proposalDecisionSummary.textContent = summary.pending > 0
    ? `${summary.pending} decision${
      summary.pending === 1 ? "" : "s"
    } remaining · ${summary.include} include · ${summary.exclude} exclude`
    : `${summary.include} to apply · ${summary.exclude} excluded`;
  proposalApprove.textContent = !modelActions
    ? "AI provider required to apply"
    : summary.pending > 0
    ? `Review ${summary.pending} remaining`
    : summary.include > 0
    ? `Apply ${summary.include} reviewed change${
      summary.include === 1 ? "" : "s"
    }`
    : "Include at least one change";
  proposalApprove.disabled = proposalBusy || !summary.canApprove ||
    !modelActions;
  proposalApprove.title = modelActions
    ? ""
    : "Applying proposed changes requires an available AI provider.";
  const allIncluded = decisions.length > 0 &&
    summary.include === decisions.length;
  proposalIncludeAll.textContent = allIncluded
    ? "All changes included"
    : "Include all changes";
  proposalIncludeAll.disabled = proposalBusy || decisions.length === 0 ||
    allIncluded;
}

function setProposalBusy(busy) {
  proposalBusy = busy;
  proposalReject.disabled = busy;
  proposalChanges.querySelectorAll("select, textarea").forEach((control) => {
    control.disabled = busy;
  });
  updateProposalApprovalControls();
}

function setProposalItemDecision(item, value) {
  const decision = item.querySelector(".proposal-change-decision");
  const body = item.querySelector(".proposal-body-edit");
  if (!decision || !body) return;
  decision.value = value;
  item.dataset.decision = value;
  body.readOnly = value !== REVIEW_DECISIONS.include;
}

function includeAllProposalChanges() {
  const items = [...proposalChanges.querySelectorAll(".proposal-change")];
  const decisions = reviewDecisionsForEveryChange(
    items.length,
    REVIEW_DECISIONS.include,
  );
  items.forEach((item, index) => {
    setProposalItemDecision(item, decisions[index]);
  });
  updateProposalApprovalControls();
  reviewStatus.textContent = `Included all ${items.length} proposed change${
    items.length === 1 ? "" : "s"
  }. Review any edits, then apply the proposal.`;
}

function setProposalLocation(proposalId) {
  const url = new URL(location.href);
  url.searchParams.set("view", "review");
  if (proposalId) url.searchParams.set("proposal", String(proposalId));
  else url.searchParams.delete("proposal");
  history.replaceState({}, "", url);
}

function proposalEvidence(change, source) {
  const evidence = document.createElement("aside");
  evidence.className = "proposal-evidence";
  const heading = document.createElement("h4");
  heading.textContent = "Source context & provenance";
  const title = document.createElement("strong");
  title.textContent = source.title;
  const summary = document.createElement("p");
  summary.textContent = source.summary
    ? `Source summary: ${source.summary}`
    : "No source summary is available.";
  const pages = document.createElement("p");
  pages.className = "proposal-evidence-pages";
  const ranges = formatPageRanges(change.sourcePages);
  pages.textContent = ranges
    ? `Referenced PDF pages ${ranges}`
    : `Source type: ${source.sourceType}`;
  evidence.append(heading, title, summary, pages);
  return evidence;
}

function proposalChangeItem(change, index, source) {
  const item = document.createElement("li");
  item.className = "proposal-change";
  item.dataset.changeIndex = String(index);
  item.dataset.decision = REVIEW_DECISIONS.pending;

  const heading = document.createElement("div");
  heading.className = "proposal-change-heading";
  const action = document.createElement("span");
  action.className = "proposal-action";
  action.dataset.action = change.action;
  action.textContent = change.action;
  const title = document.createElement("strong");
  title.textContent = change.page.title;
  const type = document.createElement("small");
  type.textContent = change.page.type;
  heading.append(action, title, type);

  const decisionLabel = document.createElement("label");
  decisionLabel.className = "proposal-decision";
  decisionLabel.textContent = "Decision";
  const decision = document.createElement("select");
  decision.className = "proposal-change-decision";
  decision.setAttribute("aria-label", `Decision for ${change.page.title}`);
  for (
    const [value, label] of [
      [REVIEW_DECISIONS.pending, "Decision required"],
      [REVIEW_DECISIONS.include, "Include in wiki"],
      [REVIEW_DECISIONS.exclude, "Exclude from approval"],
    ]
  ) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    decision.appendChild(option);
  }
  decisionLabel.appendChild(decision);

  const comparison = document.createElement("div");
  comparison.className = "proposal-comparison";

  if (change.pageId) {
    const currentPanel = document.createElement("section");
    currentPanel.className = "proposal-version proposal-version-current";
    const currentHeading = document.createElement("h4");
    currentHeading.textContent = "Current durable page";
    const currentMarkdown = document.createElement("pre");
    currentMarkdown.textContent = "Loading current page...";
    currentPanel.append(currentHeading, currentMarkdown);
    comparison.appendChild(currentPanel);
    api(`notes/${change.pageId}`).then((data) => {
      currentMarkdown.textContent = data.content;
    }).catch((error) => {
      currentMarkdown.textContent =
        `Current page could not be loaded: ${error.message}`;
    });
  }

  const proposedPanel = document.createElement("section");
  proposedPanel.className = "proposal-version proposal-version-proposed";
  const proposedHeading = document.createElement("h4");
  proposedHeading.textContent = change.pageId
    ? "Proposed evolved page"
    : "Proposed new durable page";
  const proposedBody = document.createElement("textarea");
  proposedBody.className = "proposal-body-edit";
  proposedBody.value = change.page.body;
  proposedBody.rows = Math.min(
    12,
    Math.max(5, change.page.body.split("\n").length + 2),
  );
  proposedBody.setAttribute(
    "aria-label",
    `Proposed body for ${change.page.title}`,
  );
  proposedBody.readOnly = true;
  decision.addEventListener("change", () => {
    setProposalItemDecision(item, decision.value);
    updateProposalApprovalControls();
  });
  proposedPanel.append(proposedHeading, proposedBody);
  comparison.appendChild(proposedPanel);

  const metadata = document.createElement("p");
  const tags = change.page.tags?.length
    ? `Tags: ${change.page.tags.join(", ")}`
    : "No tags";
  const links = change.page.links?.length
    ? `Links: ${change.page.links.join(", ")}`
    : "No explicit links";
  metadata.textContent = [tags, links].join(" · ");
  item.append(
    heading,
    decisionLabel,
    proposalEvidence(change, source),
    comparison,
    metadata,
  );

  if (change.pageId) {
    const current = document.createElement("button");
    current.type = "button";
    current.textContent = "Open current page";
    current.addEventListener("click", () => {
      loadNote(change.pageId);
    });
    item.appendChild(current);
  }
  return item;
}

function showProposal(proposal) {
  selectedProposalId = proposal.id;
  selectedProposalSourceId = proposal.source.id;
  document.getElementById("proposal-source-title").textContent = proposal.source
    .title;
  document.getElementById("proposal-source-meta").textContent =
    `${proposal.source.sourceType} · ${proposal.changes.length} proposed change${
      proposal.changes.length === 1 ? "" : "s"
    }`;
  document.getElementById("proposal-source-summary").textContent = proposal
    .source.summary;
  proposalChanges.replaceChildren(
    ...proposal.changes.map((change, index) =>
      proposalChangeItem(change, index, proposal.source)
    ),
  );
  proposalDetail.classList.remove("hidden");
  setProposalBusy(false);
}

async function loadProposalDetail(proposalId, button) {
  selectedProposalId = proposalId;
  setProposalLocation(proposalId);
  for (const item of proposalList.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  reviewStatus.textContent = "Loading proposed changes...";
  proposalDetail.classList.add("hidden");
  const finishOperation = beginOperation(
    "Loading proposed changes…",
    reviewStatus,
  );
  try {
    const data = await api(`proposals/${proposalId}`);
    if (selectedProposalId !== proposalId) return;
    showProposal(data.proposal);
    reviewStatus.textContent = "Review every change before deciding.";
  } catch (error) {
    if (selectedProposalId !== proposalId) return;
    reviewStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

async function loadPendingProposals(preferredId) {
  proposalList.replaceChildren();
  proposalChanges.replaceChildren();
  proposalDetail.classList.add("hidden");
  selectedProposalId = null;
  selectedProposalSourceId = null;
  reviewStatus.textContent = "Loading pending proposals...";
  const data = await api("proposals");
  const proposals = data.proposals ?? [];
  document.getElementById("review-queue-count").textContent = String(
    proposals.length,
  );
  setShellQueueCount(
    "review-count",
    proposals.length,
    "pending review",
    "pending reviews",
  );
  for (const proposal of proposals) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "proposal-list-button";
    const title = document.createElement("span");
    title.textContent = proposal.source.title;
    const count = document.createElement("small");
    count.textContent = `${proposal.changes.length} proposed change${
      proposal.changes.length === 1 ? "" : "s"
    }`;
    button.append(title, count);
    button.addEventListener(
      "click",
      () => loadProposalDetail(proposal.id, button),
    );
    item.appendChild(button);
    proposalList.appendChild(item);
    if (proposal.id === preferredId) button.dataset.preferred = "true";
  }
  if (proposals.length === 0) {
    setProposalLocation(null);
    reviewStatus.textContent = "No changes are waiting for review.";
    return;
  }
  reviewStatus.textContent = `${proposals.length} proposal${
    proposals.length === 1 ? "" : "s"
  } waiting for review.`;
  const preferred = proposalList.querySelector('[data-preferred="true"]');
  (preferred ?? proposalList.querySelector("button"))?.click();
}

async function openReviewWorkspace(preferredId, updateHistory = true) {
  setPrimaryWorkspace("review", updateHistory);
  const finishOperation = beginOperation(
    "Loading the review queue…",
    reviewStatus,
  );
  try {
    await loadPendingProposals(preferredId);
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

async function approveSelectedProposal() {
  if (!selectedProposalId) return;
  const summary = reviewDecisionSummary(proposalDecisions());
  if (summary.pending > 0) {
    reviewStatus.textContent =
      "Decide whether to include or exclude every proposed change.";
    return;
  }
  const changes = selectedProposalChanges();
  if (changes.length === 0) {
    reviewStatus.textContent = "Include at least one change before applying.";
    return;
  }
  setProposalBusy(true);
  reviewStatus.textContent = `Applying ${changes.length} reviewed change${
    changes.length === 1 ? "" : "s"
  }...`;
  const finishOperation = beginOperation(
    "Applying reviewed changes…",
    reviewStatus,
  );
  try {
    const response = await fetch(
      `/api/proposals/${selectedProposalId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      },
    );
    await consumeSse(response, async (data) => {
      const labels = {
        ingesting: "Starting approval...",
        embedding: "Embedding approved pages...",
        integrated: "Approved changes applied.",
        linking: "Refreshing connections...",
        discoveries: data.discoveries?.length
          ? `${data.discoveries.length} potential connection${
            data.discoveries.length === 1 ? "" : "s"
          } found.`
          : "No new evidence-backed connections found.",
        warning: data.error,
        done: "Approval complete.",
      };
      reviewStatus.textContent = labels[data.stage] ?? data.error ?? data.stage;
      if (data.stage === "discoveries" && data.discoveries?.length) {
        await openDiscoveriesModal(data.discoveries[0].id);
      }
      if (data.stage === "error") throw new Error(data.error);
    });
    await loadNoteList();
    await loadGraph();
    await loadPendingProposals();
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    finishOperation();
    setProposalBusy(false);
  }
}

async function rejectSelectedProposal() {
  if (!selectedProposalId) return;
  setProposalBusy(true);
  reviewStatus.textContent = "Rejecting proposal...";
  const finishOperation = beginOperation(
    "Rejecting the proposal…",
    reviewStatus,
  );
  try {
    await api(`proposals/${selectedProposalId}/reject`, {
      method: "POST",
      body: "{}",
    });
    await loadPendingProposals();
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    finishOperation();
    setProposalBusy(false);
  }
}

reviewNavigationButton.addEventListener("click", () => {
  if (primaryWorkspace !== "review") openReviewWorkspace();
});
proposalApprove.addEventListener("click", approveSelectedProposal);
proposalIncludeAll.addEventListener("click", includeAllProposalChanges);
proposalReject.addEventListener("click", rejectSelectedProposal);
proposalSourceInspect.addEventListener("click", () => {
  if (selectedProposalSourceId) openSourcesModal(selectedProposalSourceId);
});

// --- Reviewed discoveries ---

const discoveriesModal = document.getElementById("discoveries-modal");
const discoveriesStatus = document.getElementById("discoveries-status");
const discoveriesList = document.getElementById("discoveries-list");
const discoveryDetail = document.getElementById("discovery-detail");
const discoveryInvestigate = document.getElementById(
  "discovery-investigate",
);
const discoveryReject = document.getElementById("discovery-reject");
const discoveryConfirm = document.getElementById("discovery-confirm");
const discoveriesScan = document.getElementById("discoveries-scan");
const discoveryDetailTitle = document.getElementById(
  "discovery-detail-title",
);
const discoveryActionNote = document.getElementById("discovery-action-note");
const discoveryFilterText = document.getElementById("discovery-filter-text");
const discoveryFilterType = document.getElementById("discovery-filter-type");
const discoverySelectFiltered = document.getElementById(
  "discovery-select-filtered",
);
const discoveryClearSelection = document.getElementById(
  "discovery-clear-selection",
);
const discoverySelectionCount = document.getElementById(
  "discovery-selection-count",
);
const discoveryBatchReject = document.getElementById(
  "discovery-batch-reject",
);
const discoveryBatchConfirm = document.getElementById(
  "discovery-batch-confirm",
);
const discoveryBatchConfirmationPanel = document.getElementById(
  "discovery-batch-confirmation",
);
const discoveryBatchWarning = document.getElementById(
  "discovery-batch-warning",
);
const discoveryBatchConfirmationPhrase = document.getElementById(
  "discovery-batch-confirmation-phrase",
);
const discoveryBatchConfirmationInput = document.getElementById(
  "discovery-batch-confirmation-input",
);
const discoveryBatchCancel = document.getElementById(
  "discovery-batch-cancel",
);
const discoveryBatchApply = document.getElementById("discovery-batch-apply");
let selectedDiscoveryId = null;
let selectedDiscoveryStatus = null;
let openDiscoveries = [];
let filteredDiscoveries = [];
let discoveryBusy = false;
let discoveryBatchSnapshot = null;
const selectedDiscoveryIds = new Set();
let discoverySweepRunning = false;
let discoverySweepStopRequested = false;

function discoveryKindLabel(discovery) {
  return discovery.proposalKind === "consolidation"
    ? "Consolidation candidate"
    : discovery.relationshipType.replaceAll("_", " ");
}

function updateDiscoveryControls() {
  const selectionCount = selectedDiscoveryIds.size;
  discoveriesScan.disabled = !providerCapabilities(providerState.phase)
    .modelActions ||
    (discoveryBusy && !discoverySweepRunning) || discoverySweepStopRequested;
  discoveriesScan.textContent = discoverySweepRunning
    ? "Pause after current batch"
    : "Compare all sources";
  discoveryInvestigate.disabled = discoveryBusy || !selectedDiscoveryId ||
    selectedDiscoveryStatus === "investigating";
  discoveryReject.disabled = discoveryBusy || !selectedDiscoveryId;
  discoveryConfirm.disabled = discoveryBusy || !selectedDiscoveryId;
  discoveryFilterText.disabled = discoveryBusy;
  discoveryFilterType.disabled = discoveryBusy;
  discoveryBatchConfirmationInput.disabled = discoveryBusy;
  discoveryBatchCancel.disabled = discoveryBusy;
  discoverySelectFiltered.disabled = discoveryBusy ||
    filteredDiscoveries.length === 0;
  discoveryClearSelection.disabled = discoveryBusy || selectionCount === 0;
  discoveryBatchReject.disabled = discoveryBusy || selectionCount === 0;
  discoveryBatchConfirm.disabled = discoveryBusy || selectionCount === 0;
  discoverySelectionCount.textContent = `${selectionCount} selected`;
  for (
    const control of discoveriesList.querySelectorAll(
      ".discovery-select-checkbox, .discovery-list-button",
    )
  ) control.disabled = discoveryBusy;
  const expected = discoveryBatchSnapshot?.phrase ?? "";
  discoveryBatchApply.disabled = discoveryBusy || !expected ||
    discoveryBatchConfirmationInput.value !== expected;
}

function setDiscoveryBusy(busy) {
  discoveryBusy = busy;
  updateDiscoveryControls();
}

function closeDiscoveryBatchConfirmation() {
  discoveryBatchSnapshot = null;
  discoveryBatchConfirmationInput.value = "";
  discoveryBatchConfirmationPanel.classList.add("hidden");
  updateDiscoveryControls();
}

function changeDiscoverySelection(id, selected) {
  closeDiscoveryBatchConfirmation();
  if (selected) {
    if (selectedDiscoveryIds.size >= MAX_DISCOVERY_BATCH_ITEMS) {
      discoveriesStatus.textContent =
        `A batch can contain at most ${MAX_DISCOVERY_BATCH_ITEMS} proposals. Narrow the filter or review this selection first.`;
      return false;
    }
    selectedDiscoveryIds.add(id);
  } else {
    selectedDiscoveryIds.delete(id);
  }
  updateDiscoveryControls();
  return true;
}

function closeDiscoveriesModal() {
  closeModalDialog(discoveriesModal);
  selectedDiscoveryId = null;
  selectedDiscoveryStatus = null;
  closeDiscoveryBatchConfirmation();
}

function discoveryPageButton(page) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = page.title;
  button.addEventListener("click", () => {
    closeDiscoveriesModal();
    loadNote(page.id);
  });
  item.appendChild(button);
  return item;
}

function discoverySourceItem(source) {
  const item = document.createElement("li");
  const sourceUrl = safeSourceUrl(source.sourceUrl);
  if (sourceUrl) {
    const link = document.createElement("a");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;
    item.appendChild(link);
  } else {
    item.textContent = source.title;
  }
  return item;
}

function showDiscovery(discovery) {
  selectedDiscoveryId = discovery.id;
  selectedDiscoveryStatus = discovery.status;
  document.getElementById("discovery-relationship").textContent =
    discoveryKindLabel(discovery);
  document.getElementById("discovery-review-state").textContent = discovery
    .status;
  document.getElementById("discovery-explanation").textContent = discovery
    .explanation;
  document.getElementById("discovery-significance").textContent = discovery
    .significance;
  document.getElementById("discovery-confidence").textContent =
    `Model confidence: ${
      Math.round(discovery.confidence * 100)
    }% · ${discovery.productionMethod} · ${discovery.model}. This is not evidential certainty.`;
  document.getElementById("discovery-pages").replaceChildren(
    ...discovery.pages.map(discoveryPageButton),
  );
  document.getElementById("discovery-sources").replaceChildren(
    ...discovery.sources.map(discoverySourceItem),
  );
  const isConsolidation = discovery.proposalKind === "consolidation";
  discoveryDetailTitle.textContent = isConsolidation
    ? "Possible consolidation"
    : "Potential relationship";
  discoveryConfirm.textContent = isConsolidation
    ? "Confirm overlap link"
    : "Confirm link";
  discoveryActionNote.textContent = isConsolidation
    ? "Confirmation records the reviewed overlap as a typed relationship and explicit link. It does not merge or delete either page."
    : "Confirmation records this typed reviewed relationship and an ordinary explicit wiki link.";
  discoveryDetail.classList.remove("hidden");
  updateDiscoveryControls();
}

async function loadDiscoveryDetail(discoveryId, button) {
  selectedDiscoveryId = discoveryId;
  selectedDiscoveryStatus = null;
  for (const item of discoveriesList.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  discoveriesStatus.textContent = "Loading discovery evidence...";
  discoveryDetail.classList.add("hidden");
  const finishOperation = beginOperation(
    "Loading discovery evidence…",
    discoveriesStatus,
  );
  try {
    const data = await api(`discoveries/${discoveryId}`);
    if (selectedDiscoveryId !== discoveryId) return;
    showDiscovery(data.discovery);
    discoveriesStatus.textContent =
      "Review the cited pages and sources before acting.";
  } catch (error) {
    if (selectedDiscoveryId !== discoveryId) return;
    discoveriesStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

function refreshDiscoveryTypeFilter() {
  const current = discoveryFilterType.value;
  const options = [
    Object.assign(document.createElement("option"), {
      value: "all",
      textContent: "All relationships",
    }),
    ...[...new Set(openDiscoveries.map((item) => item.relationshipType))]
      .sort()
      .map((relationshipType) =>
        Object.assign(document.createElement("option"), {
          value: relationshipType,
          textContent: relationshipType.replaceAll("_", " "),
        })
      ),
  ];
  discoveryFilterType.replaceChildren(...options);
  if (options.some((option) => option.value === current)) {
    discoveryFilterType.value = current;
  }
}

function renderDiscoveryList(preferredId) {
  filteredDiscoveries = openDiscoveries.filter((discovery) =>
    discoveryMatchesFilter(
      discovery,
      discoveryFilterText.value,
      discoveryFilterType.value,
    )
  );
  discoveriesList.replaceChildren();
  for (const discovery of filteredDiscoveries) {
    const item = document.createElement("li");
    item.className = "discovery-list-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "discovery-select-checkbox";
    checkbox.checked = selectedDiscoveryIds.has(discovery.id);
    checkbox.setAttribute(
      "aria-label",
      `Select ${discovery.pages.map((page) => page.title).join(" and ")}`,
    );
    checkbox.addEventListener("change", () => {
      if (!changeDiscoverySelection(discovery.id, checkbox.checked)) {
        checkbox.checked = false;
      }
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "discovery-list-button";
    const relationship = document.createElement("span");
    relationship.textContent = discoveryKindLabel(discovery);
    const pages = document.createElement("small");
    pages.textContent = discovery.pages.map((page) => page.title).join(" ↔ ");
    button.append(relationship, pages);
    button.addEventListener(
      "click",
      () => loadDiscoveryDetail(discovery.id, button),
    );
    if (discovery.id === preferredId) button.dataset.preferred = "true";
    if (discovery.id === selectedDiscoveryId) button.classList.add("active");
    item.append(checkbox, button);
    discoveriesList.appendChild(item);
  }
  if (filteredDiscoveries.length === 0) {
    selectedDiscoveryId = null;
    selectedDiscoveryStatus = null;
    discoveryDetail.classList.add("hidden");
    discoveriesStatus.textContent = openDiscoveries.length === 0
      ? "No open synthesis proposals. Compare all sources after adding evidence."
      : "No synthesis proposals match the current filter.";
    updateDiscoveryControls();
    return;
  }
  const selectedIsVisible = filteredDiscoveries.some((discovery) =>
    discovery.id === selectedDiscoveryId
  );
  if (!selectedIsVisible) {
    selectedDiscoveryId = null;
    selectedDiscoveryStatus = null;
    discoveryDetail.classList.add("hidden");
    const preferred = discoveriesList.querySelector(
      '[data-preferred="true"]',
    );
    (preferred ?? discoveriesList.querySelector(".discovery-list-button"))
      ?.click();
  }
  updateDiscoveryControls();
}

async function loadDiscoveries(preferredId) {
  discoveriesStatus.textContent = "Loading open synthesis proposals...";
  const data = await api("discoveries");
  openDiscoveries = data.discoveries ?? [];
  const openIds = new Set(openDiscoveries.map((discovery) => discovery.id));
  for (const id of selectedDiscoveryIds) {
    if (!openIds.has(id)) selectedDiscoveryIds.delete(id);
  }
  setShellQueueCount(
    "discoveries-count",
    openDiscoveries.length,
    "open synthesis proposal",
    "open synthesis proposals",
  );
  refreshDiscoveryTypeFilter();
  renderDiscoveryList(preferredId);
}

async function openDiscoveriesModal(preferredId) {
  showModalDialog(discoveriesModal);
  const finishOperation = beginOperation(
    "Loading synthesis proposals…",
    discoveriesStatus,
  );
  try {
    await loadDiscoveries(preferredId);
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

async function scanDiscoveries() {
  if (discoverySweepRunning) {
    discoverySweepStopRequested = true;
    discoveriesScan.disabled = true;
    discoveriesStatus.textContent = "Pausing after the current batch...";
    return;
  }
  discoverySweepRunning = true;
  discoverySweepStopRequested = false;
  setDiscoveryBusy(true);
  discoveriesStatus.textContent =
    "Building the cross-source candidate frontier...";
  const finishOperation = beginOperation(
    "Comparing sources with AI…",
    discoveriesStatus,
  );
  let generation;
  let preferredId;
  let lastCoverage;
  try {
    while (true) {
      const data = await api("discoveries/generate", {
        method: "POST",
        body: JSON.stringify(generation === undefined ? {} : { generation }),
      });
      generation = data.coverage?.generation ?? undefined;
      preferredId ??= data.discoveries?.[0]?.id;
      lastCoverage = data.coverage;
      discoveriesStatus.textContent = discoveryCoverageSummary(lastCoverage);
      if (lastCoverage?.complete || discoverySweepStopRequested) break;
    }
    await loadDiscoveries(preferredId);
    discoveriesStatus.textContent = discoverySweepStopRequested
      ? `Sweep paused. ${discoveryCoverageSummary(lastCoverage)}`
      : discoveryCoverageSummary(lastCoverage);
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  } finally {
    finishOperation();
    discoverySweepRunning = false;
    discoverySweepStopRequested = false;
    setDiscoveryBusy(false);
  }
}

function selectFilteredDiscoveries() {
  closeDiscoveryBatchConfirmation();
  let added = 0;
  for (const discovery of filteredDiscoveries) {
    if (selectedDiscoveryIds.has(discovery.id)) continue;
    if (selectedDiscoveryIds.size >= MAX_DISCOVERY_BATCH_ITEMS) break;
    selectedDiscoveryIds.add(discovery.id);
    added++;
  }
  renderDiscoveryList(selectedDiscoveryId);
  if (selectedDiscoveryIds.size >= MAX_DISCOVERY_BATCH_ITEMS) {
    discoveriesStatus.textContent =
      `Selected ${MAX_DISCOVERY_BATCH_ITEMS} proposals, the maximum per batch. Review this batch or narrow the filter.`;
  } else {
    discoveriesStatus.textContent = `${added} proposal${
      added === 1 ? "" : "s"
    } added to the selection.`;
  }
}

function beginDiscoveryBatch(action) {
  if (selectedDiscoveryIds.size === 0) return;
  const ids = [...selectedDiscoveryIds].sort((left, right) => left - right);
  const phrase = discoveryBatchConfirmation(action, ids.length);
  discoveryBatchSnapshot = { action, ids, phrase };
  discoveryBatchConfirmationPhrase.textContent = phrase;
  discoveryBatchWarning.textContent = action === "confirm"
    ? `This records ${ids.length} model-proposed relationships as portable typed metadata and explicit wiki links. Every evidence page must still match the version reviewed by the model.`
    : `This rejects ${ids.length} selected proposals. No wiki links will be added.`;
  discoveryBatchConfirmationInput.value = "";
  discoveryBatchConfirmationPanel.classList.remove("hidden");
  discoveryBatchConfirmationInput.focus();
  updateDiscoveryControls();
}

async function applyDiscoveryBatch() {
  const snapshot = discoveryBatchSnapshot;
  if (
    !snapshot ||
    discoveryBatchConfirmationInput.value !== snapshot.phrase
  ) return;
  setDiscoveryBusy(true);
  discoveriesStatus.textContent = snapshot.action === "confirm"
    ? `Confirming ${snapshot.ids.length} selected relationships...`
    : `Rejecting ${snapshot.ids.length} selected proposals...`;
  const finishOperation = beginOperation(
    snapshot.action === "confirm"
      ? "Confirming selected relationships…"
      : "Rejecting selected proposals…",
    discoveriesStatus,
  );
  try {
    const result = await api("discoveries/batch", {
      method: "POST",
      body: JSON.stringify({
        action: snapshot.action,
        ids: snapshot.ids,
        confirm: snapshot.phrase,
      }),
    });
    if (snapshot.action === "confirm") await loadGraph();
    for (const id of snapshot.ids) selectedDiscoveryIds.delete(id);
    closeDiscoveryBatchConfirmation();
    await loadDiscoveries();
    discoveriesStatus.textContent = snapshot.action === "confirm"
      ? `Confirmed ${result.reviewed.length} proposals and added ${result.linksAdded} typed reviewed links.`
      : `Rejected ${result.reviewed.length} proposals. No wiki links were added.`;
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  } finally {
    finishOperation();
    setDiscoveryBusy(false);
  }
}

async function reviewSelectedDiscovery(action) {
  if (!selectedDiscoveryId) return;
  setDiscoveryBusy(true);
  discoveriesStatus.textContent = `${action} discovery...`;
  const actionLabel = {
    investigate: "Marking the discovery for investigation…",
    reject: "Rejecting the discovery…",
    confirm: "Confirming the discovery link…",
  }[action];
  const finishOperation = beginOperation(actionLabel, discoveriesStatus);
  try {
    const data = await api(`discoveries/${selectedDiscoveryId}/${action}`, {
      method: "POST",
      body: "{}",
    });
    if (action === "investigate") {
      showDiscovery(data.discovery);
      discoveriesStatus.textContent = "Marked for investigation.";
      return;
    }
    if (action === "confirm") await loadGraph();
    await loadDiscoveries();
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  } finally {
    finishOperation();
    setDiscoveryBusy(false);
    if (action === "investigate") discoveryInvestigate.disabled = true;
  }
}

discoveryFilterText.addEventListener("input", () => renderDiscoveryList());
discoveryFilterType.addEventListener("change", () => renderDiscoveryList());
discoverySelectFiltered.addEventListener("click", selectFilteredDiscoveries);
discoveryClearSelection.addEventListener("click", () => {
  selectedDiscoveryIds.clear();
  closeDiscoveryBatchConfirmation();
  renderDiscoveryList(selectedDiscoveryId);
  discoveriesStatus.textContent = "Selection cleared.";
});
discoveryBatchReject.addEventListener(
  "click",
  () => beginDiscoveryBatch("reject"),
);
discoveryBatchConfirm.addEventListener(
  "click",
  () => beginDiscoveryBatch("confirm"),
);
discoveryBatchConfirmationInput.addEventListener(
  "input",
  updateDiscoveryControls,
);
discoveryBatchCancel.addEventListener("click", closeDiscoveryBatchConfirmation);
discoveryBatchApply.addEventListener("click", applyDiscoveryBatch);
document.getElementById("discoveries-open-btn").addEventListener(
  "click",
  () => openDiscoveriesModal(),
);
document.getElementById("discoveries-close").addEventListener(
  "click",
  closeDiscoveriesModal,
);
bindModalDismissal(discoveriesModal, closeDiscoveriesModal);
discoveriesScan.addEventListener("click", scanDiscoveries);
discoveryInvestigate.addEventListener(
  "click",
  () => reviewSelectedDiscovery("investigate"),
);
discoveryReject.addEventListener(
  "click",
  () => reviewSelectedDiscovery("reject"),
);
discoveryConfirm.addEventListener(
  "click",
  () => reviewSelectedDiscovery("confirm"),
);
// --- Provider onboarding ---

const providerModal = document.getElementById("provider-modal");
const providerForm = document.getElementById("provider-form");
const providerSave = document.getElementById("provider-save");
const providerStatus = document.getElementById("provider-status");
const providerModeBadge = document.getElementById("provider-mode");
const providerOllama = document.getElementById("provider-ollama");
const providerDiagnose = document.getElementById("provider-diagnose");
const providerDiagnostics = document.getElementById("provider-diagnostics");
const providerDiagnosticsSummary = document.getElementById(
  "provider-diagnostics-summary",
);
const providerDiagnosticsModels = document.getElementById(
  "provider-diagnostics-models",
);
const llmKeyInput = document.getElementById("provider-llm-key");
const embeddingKeyInput = document.getElementById("provider-embed-key");
const askOpenButton = document.getElementById("ask-open-btn");
const ingestButton = document.getElementById("ingest-btn");
const ingestCancelButton = document.getElementById("ingest-cancel-btn");
let activeIngestController = null;
let providerState = { phase: "checking", mode: "unknown" };
let vaultEmbeddingDimensions = 768;

function setProviderBusy(busy) {
  for (const control of providerForm.elements) control.disabled = busy;
  providerSave.textContent = busy ? "Testing..." : "Test and save";
  providerOllama.disabled = busy;
  providerDiagnose.disabled = busy;
}

function renderProviderState(nextState) {
  providerState = { ...providerState, ...nextState };
  const presentation = providerPresentation(providerState);
  const capabilities = providerCapabilities(
    providerState.phase,
    providerState.semanticIndex,
  );
  providerModeBadge.dataset.mode = presentation.badgeMode;
  providerModeBadge.textContent = presentation.text;
  providerModeBadge.title = presentation.description;
  providerModeBadge.setAttribute(
    "aria-label",
    `${presentation.text}. ${presentation.description} Open AI provider settings.`,
  );

  addSourceButton.disabled = !capabilities.modelActions;
  askOpenButton.disabled = !capabilities.modelActions;
  discoveriesScan.disabled = !capabilities.modelActions;
  lintAnalyse.disabled = !capabilities.modelActions;
  ingestButton.disabled = !capabilities.modelActions ||
    activeIngestController !== null;
  renderSemanticRebuildButton();
  const emptyState = providerEmptyState(providerState.phase);
  readerAddSourceButton.textContent = emptyState.label;
  readerAddSourceButton.title = capabilities.modelActions
    ? ""
    : "Configure an AI provider before preparing the first source.";
  searchInput.placeholder = capabilities.modelActions
    ? "Search your knowledge base..."
    : "Search wiki pages (keyword)...";
  const unavailableHelp =
    "AI is unavailable. Reading, evidence, review queues, and keyword search still work.";
  for (
    const control of [
      addSourceButton,
      askOpenButton,
      discoveriesScan,
      lintAnalyse,
      ingestButton,
    ]
  ) {
    control.title = capabilities.modelActions ? "" : unavailableHelp;
  }
  updateProposalApprovalControls();
}

async function refreshProviderMode() {
  renderProviderState({ phase: "checking" });
  let configured;
  try {
    configured = await api("provider");
    renderProviderState({ phase: "configured", mode: configured.mode });
  } catch {
    renderProviderState({ phase: "unavailable" });
    return null;
  }
  renderProviderState({ phase: "checking", mode: configured.mode });
  try {
    const data = await api("provider/readiness");
    renderProviderState({
      phase: data.readiness?.ready ? "ready" : "unavailable",
      mode: data.readiness?.mode ?? configured.mode,
      semanticIndex: data.semanticIndex ?? null,
    });
    return { ...configured, readiness: data.readiness };
  } catch {
    renderProviderState({ phase: "unavailable", mode: configured.mode });
    return { ...configured, readiness: null };
  }
}

function updateKeyHint(id, stored) {
  document.getElementById(id).textContent = stored
    ? "A key is stored. Leave blank to keep it."
    : "Required for first-time setup.";
}

function populateProviderForm(data) {
  if (Number.isSafeInteger(data.embeddingDimensions)) {
    vaultEmbeddingDimensions = data.embeddingDimensions;
  }
  const profile = data.profile;
  if (profile) {
    providerForm.elements.displayName.value = profile.displayName;
    providerForm.elements.llmApiBase.value = profile.llm.apiBase;
    providerForm.elements.llmModel.value = profile.llm.model;
    providerForm.elements.embeddingApiBase.value = profile.embedding.apiBase;
    providerForm.elements.embeddingModel.value = profile.embedding.model;
    providerForm.elements.embeddingDimensions.value = profile.embedding
      .dimensions;
  } else if (Number.isSafeInteger(data.embeddingDimensions)) {
    providerForm.elements.embeddingDimensions.value = data.embeddingDimensions;
  }
  if (data.source === "environment") {
    document.getElementById("provider-llm-key-hint").textContent =
      "Using the active environment/default value.";
    document.getElementById("provider-embed-key-hint").textContent =
      "Using the active environment/default value.";
  } else {
    updateKeyHint("provider-llm-key-hint", data.llmKeyStored);
    updateKeyHint("provider-embed-key-hint", data.embeddingKeyStored);
  }
}

async function openProviderModal() {
  showModalDialog(providerModal);
  providerStatus.textContent = "Loading provider settings...";
  setProviderBusy(true);
  const finishOperation = beginOperation(
    "Loading AI provider settings…",
    providerStatus,
  );
  try {
    const data = await api("provider");
    populateProviderForm(data);
    providerStatus.textContent = providerState.phase === "unavailable"
      ? "AI is currently unavailable. Existing wiki knowledge remains usable; update settings or run diagnostics."
      : data.source === "environment"
      ? "Default provider is active. Run diagnostics to verify its models."
      : data.configured
      ? "Provider is configured."
      : "Complete the profile and test both connections.";
  } catch (error) {
    providerStatus.textContent = error.message;
  } finally {
    finishOperation();
    setProviderBusy(false);
  }
}

function useOllamaPreset() {
  const preset = ollamaPreset(vaultEmbeddingDimensions);
  providerForm.elements.displayName.value = preset.displayName;
  providerForm.elements.llmApiBase.value = preset.llmApiBase;
  providerForm.elements.llmModel.value = preset.llmModel;
  providerForm.elements.embeddingApiBase.value = preset.embeddingApiBase;
  providerForm.elements.embeddingModel.value = preset.embeddingModel;
  providerForm.elements.embeddingDimensions.value = preset
    .embeddingDimensions;
  llmKeyInput.value = "ollama";
  embeddingKeyInput.value = "ollama";
  providerStatus.textContent =
    "Local preset loaded. Test and save it, then run diagnostics.";
}

function renderProviderDiagnostics(diagnostics) {
  providerDiagnosticsModels.replaceChildren();
  const mode = diagnostics.mode === "local" ? "Local" : "Remote";
  const chatLatency = diagnostics.chat.probe?.latencyMs;
  const embeddingLatency = diagnostics.embedding.probe?.latencyMs;
  providerDiagnosticsSummary.textContent = diagnostics.ready
    ? `${mode} provider is ready · chat ${chatLatency} ms · embeddings ${embeddingLatency} ms.`
    : `${mode} provider is reachable but is not compatible yet.`;
  for (
    const [kind, group] of [
      ["chat", diagnostics.chat],
      ["embedding", diagnostics.embedding],
    ]
  ) {
    for (const model of group.missingModels) {
      const item = document.createElement("li");
      item.textContent = diagnostics.mode === "local"
        ? `ollama pull ${model}`
        : `Missing ${kind} model: ${model}`;
      providerDiagnosticsModels.appendChild(item);
    }
  }

  if (diagnostics.chat.probe?.attempted) {
    const item = document.createElement("li");
    item.textContent = diagnostics.chat.probe.ok
      ? `Chat JSON check passed in ${chatLatency} ms.`
      : `Chat JSON check failed: ${diagnostics.chat.probe.error}`;
    providerDiagnosticsModels.appendChild(item);
  }
  if (diagnostics.embedding.probe?.attempted) {
    const item = document.createElement("li");
    item.textContent = diagnostics.embedding.probe.ok
      ? `Embedding check passed in ${embeddingLatency} ms · ${diagnostics.embedding.actualDimensions} dimensions.`
      : `Embedding check failed: ${diagnostics.embedding.probe.error}`;
    providerDiagnosticsModels.appendChild(item);
  }
  providerDiagnostics.classList.remove("hidden");
}

async function diagnoseActiveProvider() {
  setProviderBusy(true);
  providerStatus.textContent =
    "Checking models and running live compatibility checks. Cold models may take a moment...";
  providerDiagnostics.classList.add("hidden");
  const finishOperation = beginOperation(
    "Diagnosing the active AI provider…",
    providerStatus,
  );
  try {
    const data = await api("provider/diagnose", {
      method: "POST",
      body: "{}",
    });
    renderProviderDiagnostics(data.diagnostics);
    renderProviderState({
      phase: data.diagnostics.ready ? "ready" : "unavailable",
      mode: data.diagnostics.mode,
    });
    providerStatus.textContent = data.diagnostics.ready
      ? "Provider diagnostics passed."
      : "Resolve the listed model or compatibility issue, then diagnose again.";
  } catch (error) {
    renderProviderState({ phase: "unavailable" });
    providerStatus.textContent = error.message;
  } finally {
    finishOperation();
    setProviderBusy(false);
  }
}

function closeProviderModal() {
  closeModalDialog(providerModal);
  llmKeyInput.value = "";
  embeddingKeyInput.value = "";
}

async function saveProvider(event) {
  event.preventDefault();
  if (!providerForm.reportValidity()) return;
  const fields = new FormData(providerForm);
  setProviderBusy(true);
  providerStatus.textContent = "Testing chat and embedding connections...";
  const finishOperation = beginOperation(
    "Testing and saving the AI provider…",
    providerStatus,
  );
  try {
    const data = await api("provider", {
      method: "POST",
      body: JSON.stringify({
        profile: {
          id: "default",
          displayName: fields.get("displayName"),
          llm: {
            apiBase: fields.get("llmApiBase"),
            model: fields.get("llmModel"),
          },
          embedding: {
            apiBase: fields.get("embeddingApiBase"),
            model: fields.get("embeddingModel"),
            dimensions: Number(fields.get("embeddingDimensions")),
          },
        },
        llmApiKey: fields.get("llmApiKey"),
        embeddingApiKey: fields.get("embeddingApiKey"),
      }),
    });
    populateProviderForm(data);
    await refreshProviderMode();
    providerStatus.textContent = "Provider tested and saved.";
  } catch (error) {
    providerStatus.textContent = error.message;
  } finally {
    finishOperation();
    llmKeyInput.value = "";
    embeddingKeyInput.value = "";
    setProviderBusy(false);
  }
}

document.getElementById("provider-open-btn").addEventListener(
  "click",
  openProviderModal,
);
providerModeBadge.addEventListener("click", openProviderModal);
document.getElementById("provider-close").addEventListener(
  "click",
  closeProviderModal,
);
bindModalDismissal(providerModal, closeProviderModal);
providerForm.addEventListener("submit", saveProvider);
providerOllama.addEventListener("click", useOllamaPreset);
providerDiagnose.addEventListener("click", diagnoseActiveProvider);
// --- Wiki schema ---

const schemaModal = document.getElementById("schema-modal");
const schemaInput = document.getElementById("schema-input");
const schemaSave = document.getElementById("schema-save");
const schemaStatus = document.getElementById("schema-status");

function setSchemaBusy(busy) {
  schemaInput.disabled = busy;
  schemaSave.disabled = busy;
}

async function openSchemaModal() {
  showModalDialog(schemaModal);
  schemaStatus.textContent = "Loading schema...";
  setSchemaBusy(true);
  const finishOperation = beginOperation(
    "Loading the wiki schema…",
    schemaStatus,
  );
  try {
    const data = await api("schema");
    schemaInput.value = data.schema;
    schemaStatus.textContent = "Stored locally as schema.md.";
  } catch (error) {
    schemaStatus.textContent = error.message;
  } finally {
    finishOperation();
    setSchemaBusy(false);
  }
}

function closeSchemaModal() {
  closeModalDialog(schemaModal);
}

async function saveSchema() {
  setSchemaBusy(true);
  schemaSave.textContent = "Saving...";
  schemaStatus.textContent = "Validating schema...";
  const finishOperation = beginOperation(
    "Validating and saving the wiki schema…",
    schemaStatus,
  );
  try {
    const data = await api("schema", {
      method: "PUT",
      body: JSON.stringify({ schema: schemaInput.value }),
    });
    schemaInput.value = data.schema;
    schemaStatus.textContent = "Schema saved and active.";
  } catch (error) {
    schemaStatus.textContent = error.message;
  } finally {
    finishOperation();
    schemaSave.textContent = "Save schema";
    setSchemaBusy(false);
  }
}

document.getElementById("schema-open-btn").addEventListener(
  "click",
  openSchemaModal,
);
document.getElementById("schema-close").addEventListener(
  "click",
  closeSchemaModal,
);
bindModalDismissal(schemaModal, closeSchemaModal);
schemaSave.addEventListener("click", saveSchema);

// --- Source provenance review ---

const sourcesModal = document.getElementById("sources-modal");
const sourcesStatus = document.getElementById("sources-status");
const sourcesList = document.getElementById("sources-list");
const sourceDetail = document.getElementById("source-detail");
let selectedSourceId = null;

function safeSourceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function closeSourcesModal() {
  closeModalDialog(sourcesModal);
  selectedSourceId = null;
}

function showSourceDetail(data) {
  document.getElementById("source-detail-title").textContent = data.title;
  document.getElementById("source-detail-meta").textContent =
    `${data.sourceType} · ${data.createdAt}`;
  document.getElementById("source-detail-summary").textContent = data.summary;

  const originalLink = document.getElementById("source-detail-link");
  const sourceUrl = safeSourceUrl(data.sourceUrl);
  if (sourceUrl) {
    originalLink.href = sourceUrl;
    originalLink.classList.remove("hidden");
  } else {
    originalLink.removeAttribute("href");
    originalLink.classList.add("hidden");
  }

  const pages = document.getElementById("source-detail-pages");
  pages.replaceChildren();
  for (const page of data.pages ?? []) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = page.title;
    button.addEventListener("click", () => {
      closeSourcesModal();
      loadNote(page.id);
    });
    const action = document.createElement("small");
    action.textContent = page.sourcePages?.length
      ? `${page.action} · source pages ${page.sourcePages.join(", ")}`
      : page.action;
    item.append(button, action);
    pages.appendChild(item);
  }
  if (!data.pages?.length) {
    const item = document.createElement("li");
    item.textContent = "No derived pages are recorded.";
    pages.appendChild(item);
  }
  sourceDetail.classList.remove("hidden");
}

async function loadSourceDetail(sourceId, button) {
  selectedSourceId = sourceId;
  for (const item of sourcesList.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  sourcesStatus.textContent = "Loading source provenance...";
  const finishOperation = beginOperation(
    "Loading source provenance…",
    sourcesStatus,
  );
  try {
    const data = await api(`sources/${sourceId}`);
    if (selectedSourceId !== sourceId) return;
    showSourceDetail(data);
    sourcesStatus.textContent = "";
  } catch (error) {
    if (selectedSourceId !== sourceId) return;
    sourceDetail.classList.add("hidden");
    sourcesStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

async function openSourcesModal(preferredSourceId) {
  showModalDialog(sourcesModal);
  sourcesList.replaceChildren();
  sourceDetail.classList.add("hidden");
  sourcesStatus.textContent = "Loading sources...";
  const finishOperation = beginOperation(
    "Loading source provenance…",
    sourcesStatus,
  );
  try {
    const data = await api("sources");
    const sources = data.sources ?? [];
    for (const source of sources) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "source-list-button";
      button.dataset.sourceId = String(source.id);
      const title = document.createElement("span");
      title.textContent = source.title;
      const count = document.createElement("small");
      count.textContent = `${source.pageCount} derived page${
        source.pageCount === 1 ? "" : "s"
      }`;
      button.append(title, count);
      button.addEventListener(
        "click",
        () => loadSourceDetail(source.id, button),
      );
      item.appendChild(button);
      sourcesList.appendChild(item);
    }
    if (sources.length === 0) {
      sourcesStatus.textContent = "No sources have been ingested yet.";
      return;
    }
    sourcesStatus.textContent = `${sources.length} source${
      sources.length === 1 ? "" : "s"
    }`;
    const preferred = preferredSourceId === undefined
      ? null
      : sourcesList.querySelector(
        `button[data-source-id="${CSS.escape(String(preferredSourceId))}"]`,
      );
    (preferred ?? sourcesList.querySelector("button"))?.click();
  } catch (error) {
    sourcesStatus.textContent = error.message;
  } finally {
    finishOperation();
  }
}

document.getElementById("sources-open-btn").addEventListener(
  "click",
  () => openSourcesModal(),
);
document.getElementById("sources-close").addEventListener(
  "click",
  closeSourcesModal,
);
bindModalDismissal(sourcesModal, closeSourcesModal);

// --- Deterministic wiki health checks ---

const lintModal = document.getElementById("lint-modal");
const lintRefresh = document.getElementById("lint-refresh");
const lintAnalyse = document.getElementById("lint-analyse");
const lintStatus = document.getElementById("lint-status");
const lintSummary = document.getElementById("lint-summary");
const lintIssues = document.getElementById("lint-issues");
const lintAnalysis = document.getElementById("lint-analysis");
const lintAnalysisFindings = document.getElementById(
  "lint-analysis-findings",
);

function closeLintModal() {
  closeModalDialog(lintModal);
}

function lintCount(label, count) {
  const item = document.createElement("span");
  item.className = "lint-count";
  item.textContent = `${count} ${label}`;
  return item;
}

async function runWikiLint() {
  lintRefresh.disabled = true;
  lintAnalyse.disabled = true;
  lintStatus.textContent = "Checking wiki structure and provenance...";
  lintSummary.classList.add("hidden");
  lintIssues.replaceChildren();
  lintAnalysis.classList.add("hidden");
  lintAnalysisFindings.replaceChildren();
  const finishOperation = beginOperation(
    "Checking wiki structure and provenance…",
    lintStatus,
  );
  try {
    const report = await api("lint");
    lintSummary.replaceChildren(
      lintCount("pages", report.pageCount),
      lintCount("sources", report.sourceCount),
      lintCount("errors", report.errorCount),
      lintCount("warnings", report.warningCount),
      lintCount("information", report.infoCount),
    );
    lintSummary.classList.remove("hidden");
    for (const issue of report.issues ?? []) {
      const item = document.createElement("li");
      item.className = "lint-issue";
      item.dataset.severity = issue.severity;
      const pageButton = document.createElement("button");
      pageButton.type = "button";
      pageButton.textContent = issue.pageTitle;
      pageButton.addEventListener("click", () => {
        closeLintModal();
        loadNote(issue.pageId);
      });
      const message = document.createElement("span");
      message.textContent = issue.message;
      item.append(pageButton, message);
      lintIssues.appendChild(item);
    }
    lintStatus.textContent = report.issues?.length
      ? `${report.issues.length} finding(s). Lint made no changes.`
      : "No structural or provenance issues found.";
  } catch (error) {
    lintStatus.textContent = error.message;
  } finally {
    finishOperation();
    lintRefresh.disabled = false;
    lintAnalyse.disabled = !providerCapabilities(providerState.phase)
      .modelActions;
  }
}

async function analyseWikiHealth() {
  lintRefresh.disabled = true;
  lintAnalyse.disabled = true;
  lintStatus.textContent =
    "Analysing contradictions, stale claims, and gaps...";
  const finishOperation = beginOperation(
    "Analysing wiki health with AI…",
    lintStatus,
  );
  try {
    const analysis = await api("lint/analyze", {
      method: "POST",
      body: "{}",
    });
    lintAnalysisFindings.replaceChildren();
    for (const finding of analysis.findings ?? []) {
      const item = document.createElement("li");
      item.className = "lint-analysis-finding";
      item.dataset.severity = finding.severity;
      const summary = document.createElement("div");
      summary.textContent = finding.summary;
      item.appendChild(summary);
      for (const pageId of finding.pageIds ?? []) {
        const page = currentNotes.find((note) => note.id === pageId);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = page?.title ?? `Wiki page ${pageId}`;
        button.addEventListener("click", () => {
          closeLintModal();
          loadNote(pageId);
        });
        item.appendChild(button);
      }
      const recommendation = document.createElement("span");
      recommendation.className = "lint-recommendation";
      recommendation.textContent = `Next step: ${finding.recommendation}`;
      item.appendChild(recommendation);
      lintAnalysisFindings.appendChild(item);
    }
    lintAnalysis.classList.remove("hidden");
    lintStatus.textContent = analysis.findings?.length
      ? `${analysis.findings.length} cited AI finding(s). No changes were made.`
      : "AI analysis found no supported additional issues.";
  } catch (error) {
    lintStatus.textContent = error.message;
  } finally {
    finishOperation();
    lintRefresh.disabled = false;
    lintAnalyse.disabled = !providerCapabilities(providerState.phase)
      .modelActions;
  }
}

document.getElementById("lint-open-btn").addEventListener("click", () => {
  showModalDialog(lintModal);
  runWikiLint();
});
document.getElementById("lint-close").addEventListener("click", closeLintModal);
bindModalDismissal(lintModal, closeLintModal);
lintRefresh.addEventListener("click", runWikiLint);
lintAnalyse.addEventListener("click", analyseWikiHealth);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEvidence(page) {
  const summary = evidenceSummary(page);
  const sourceById = new Map(
    (page.sources ?? []).map((source) => [source.id, source]),
  );
  const claims = (page.claims ?? []).map((claim) => {
    const text = compactEvidenceText(claim.text);
    const citedSources = (claim.sourceIds ?? []).map((sourceId) =>
      sourceById.get(sourceId)
    ).filter(Boolean);
    const citations = citedSources.length > 0
      ? citedSources.map((source) => {
        const location = evidenceSourceLocation(source);
        return `<button type="button" class="note-source-link" ` +
          `data-source-id="${source.id}">${escapeHtml(source.title)}` +
          `${location ? ` · ${escapeHtml(location)}` : ""}</button>`;
      }).join("")
      : "<span>No catalogued source</span>";
    const fullClaim = text.truncated
      ? `<details class="note-claim-full"><summary>Read full claim</summary>` +
        `<p>${escapeHtml(text.fullText)}</p></details>`
      : "";
    return `<li><p>${escapeHtml(text.preview)}</p>` +
      `<div class="note-claim-citations">${citations}</div>` +
      `${fullClaim}</li>`;
  }).join("");
  const sources = (page.sources ?? []).map((source) => {
    const summaryText = String(source.summary ?? "").trim();
    const detail = [
      evidenceActionLabel(source.action),
      evidenceSourceLocation(source),
    ].filter(Boolean).join(" · ");
    const sourceSummary = summaryText
      ? `<details class="note-source-summary"><summary>Source summary</summary>` +
        `<p>${escapeHtml(summaryText)}</p></details>`
      : "";
    return `<li><button type="button" class="note-source-link" ` +
      `data-source-id="${source.id}">${escapeHtml(source.title)}</button>` +
      `<small>${escapeHtml(detail)}</small>` +
      `${sourceSummary}</li>`;
  }).join("");
  const related = (page.related ?? []).map((item) => {
    const relationshipTypes = item.kind === "explicit"
      ? [
        ...new Set((item.relationships ?? []).map((relationship) =>
          String(relationship.type).replaceAll("_", " ")
        )),
      ]
      : [];
    const label = item.kind === "explicit"
      ? `Reviewed wiki link${
        relationshipTypes.length > 0 ? ` · ${relationshipTypes.join(", ")}` : ""
      }`
      : "Mutual semantic proximity";
    return `<li><a href="/?note=${encodeURIComponent(item.id)}" ` +
      `data-id="${item.id}" class="related-link">${
        escapeHtml(item.title)
      }</a><small>${escapeHtml(label)}</small></li>`;
  }).join("");

  evidenceContent.innerHTML = `
    <div class="evidence-summary" aria-label="Evidence summary">
      <span><strong>${summary.sourceCount}</strong> sources</span>
      <span><strong>${summary.claimCount}</strong> cited claims</span>
      <span><strong>${summary.explicitLinkCount}</strong> reviewed links</span>
    </div>
    <section class="evidence-section">
      <h3>Claim evidence</h3>
      ${
    claims
      ? `<ol class="note-claim-list">${claims}</ol>`
      : '<p class="evidence-empty">No claim-level citations recorded.</p>'
  }
    </section>
    <section class="evidence-section">
      <h3>Sources</h3>
      ${
    sources
      ? `<ul class="note-sources">${sources}</ul>`
      : '<p class="evidence-empty">No source provenance recorded.</p>'
  }
    </section>
    <section class="evidence-section">
      <h3>Related pages</h3>
      ${
    related
      ? `<ul class="related-pages">${related}</ul>`
      : '<p class="evidence-empty">No related pages yet.</p>'
  }
    </section>`;

  evidenceContent.querySelectorAll(".note-source-link").forEach((element) => {
    element.addEventListener("click", async () => {
      await openSourcesModal(Number(element.dataset.sourceId));
    });
  });
  evidenceContent.querySelectorAll(".related-link").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (
        event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      loadNote(Number(element.dataset.id));
    });
  });
}

async function loadNote(id, listButton, updateHistory = true) {
  const data = await api(`notes/${encodeURIComponent(id)}`);
  setPrimaryWorkspace("wiki", false);
  if (updateHistory) {
    const url = new URL(location.href);
    url.searchParams.delete("view");
    url.searchParams.delete("proposal");
    if (url.searchParams.get("note") !== String(id)) {
      url.searchParams.set("note", String(id));
      history.pushState({}, "", url);
    } else if (url.href !== location.href) {
      history.pushState({}, "", url);
    }
  }
  document.querySelectorAll("#note-list [data-id]").forEach((element) => {
    element.classList.remove("active");
  });
  const activeItem = listButton ?? document.querySelector(
    `#note-list [data-id="${CSS.escape(String(id))}"]`,
  );
  activeItem?.classList.add("active");

  noteContent.innerHTML = `
    <header class="reader-page-header">
      <p class="reader-page-state">Compiled wiki page</p>
      <h1>${escapeHtml(data.title)}</h1>
      <p>${data.sources?.length ?? 0} supporting source${
    data.sources?.length === 1 ? "" : "s"
  } · ${data.claims?.length ?? 0} cited claim${
    data.claims?.length === 1 ? "" : "s"
  }</p>
    </header>
    <div class="note-body">${data.bodyHtml}</div>`;
  renderEvidence(data);
  updateReader({ type: "select-note", noteId: Number(id) });
  noteContent.focus({ preventScroll: true });
}

// --- Search ---

const searchInput = document.getElementById("search-input");
const graphSearchContext = document.getElementById("graph-search-context");
const graphSearchSummary = document.getElementById("graph-search-summary");
const graphSearchClearButton = document.getElementById("graph-search-clear");
const graphSearchLegend = document.getElementById("legend-search-match");
const graphFocusContext = document.getElementById("graph-focus-context");
const graphFocusSummary = document.getElementById("graph-focus-summary");
const graphFocusOpenButton = document.getElementById("graph-focus-open");
const graphFocusClearButton = document.getElementById("graph-focus-clear");
const graphPageFilter = document.getElementById("graph-page-filter");
const graphPageList = document.getElementById("graph-page-list");
const graphPageCount = document.getElementById("graph-page-count");
const graphDirectoryTitle = document.getElementById("graph-directory-title");

function clearGraphFocus() {
  const restoreFocus = graphFocusContext.contains(document.activeElement);
  graphFocusId = null;
  graphPageFilter.value = "";
  renderGraphFocusContext();
  refreshGraphFocusHighlight();
  if (restoreFocus) graphPageFilter.focus({ preventScroll: true });
}

function setGraphFocus(noteId) {
  if (graphFocusNodeIds(graphData.nodes, graphData.links, noteId).size === 0) {
    return;
  }
  graphFocusId = noteId;
  graphPageFilter.value = "";
  renderGraphFocusContext();
  refreshGraphFocusHighlight();
}

function clearGraphSearch() {
  graphSearch = null;
  graphFocusId = null;
  graphPageFilter.value = "";
  applySemanticNeighbourhoodBreadth();
}

async function clearSearch() {
  searchInput.value = "";
  clearGraphSearch();
  await loadNoteList();
}

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = e.target.value.trim();
    if (q.length < 2) return;
    doSearch(q);
  }
  if (e.key === "Escape") {
    if (!graphMaximized) void clearSearch();
  }
});
searchInput.addEventListener("input", () => {
  if (!searchInput.value.trim() && graphSearch !== null) {
    void clearSearch();
  }
});
graphSearchClearButton.addEventListener("click", () => {
  void clearSearch().then(() => searchInput.focus());
});
graphFocusOpenButton.addEventListener("click", () => {
  if (graphFocusId !== null) void loadNote(graphFocusId);
});
graphFocusClearButton.addEventListener("click", clearGraphFocus);
graphPageFilter.addEventListener("input", renderGraphPageList);
graphPageList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page-id]");
  if (!button) return;
  graphAutoFitPending = false;
  setGraphFocus(Number(button.dataset.pageId));
  revealGraphNode(graphFocusId);
  // The neighbour list is replaced on selection; keep keyboard focus usable.
  graphFocusOpenButton.focus({ preventScroll: true });
});

function renderGraphPageList() {
  const rows = graphFocusId === null
    ? [...graphData.nodes].sort((a, b) =>
      Number(graphSearch?.matchedIds.has(b.id) ?? false) -
        Number(graphSearch?.matchedIds.has(a.id) ?? false) ||
      a.title.localeCompare(b.title) || a.id - b.id
    )
    : graphNeighbourRows(graphData.nodes, graphData.links, graphFocusId);
  const query = graphPageFilter.value.trim().toLocaleLowerCase();
  const matches = rows.filter((row) =>
    row.title.toLocaleLowerCase().includes(query)
  );
  graphDirectoryTitle.textContent = graphFocusId === null
    ? "Pages in this view"
    : "Connected pages";
  graphPageCount.textContent = graphUnavailable
    ? "Connections unavailable. Refresh to retry."
    : rows.length === 0 && graphFocusId !== null
    ? "No connections at the current suggestion setting."
    : `${matches.length} of ${rows.length} pages${
      query ? " match this filter" : ""
    }`;
  graphPageList.replaceChildren();
  for (const row of matches) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pageId = String(row.id);
    const title = document.createElement("span");
    title.textContent = row.title;
    button.appendChild(title);
    const detail = document.createElement("small");
    detail.textContent = [
      graphSearch?.matchedIds.has(row.id) ? "Search match" : "",
      ...(row.kinds ?? []).map((kind) =>
        kind === "explicit"
          ? "Reviewed wiki link"
          : "Semantic suggestion · similarity only"
      ),
    ].filter(Boolean).join(" · ");
    if (detail.textContent) button.appendChild(detail);
    item.appendChild(button);
    graphPageList.appendChild(item);
  }
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && graphMaximized) {
    event.preventDefault();
    setGraphMaximized(false);
    graphMaximizeButton.focus();
    return;
  }
  if (
    event.key === "Escape" && event.target !== searchInput &&
    graphFocusId !== null
  ) {
    clearGraphFocus();
  }
});

async function doSearch(q, requestedMode) {
  setPrimaryWorkspace("wiki");
  const list = document.getElementById("note-list");
  const pageCount = document.getElementById("page-count");

  list.innerHTML =
    '<li style="color:#7a7f94;font-style:italic">Searching...</li>';
  searchInput.disabled = true;
  clearGraphSearch();
  let attemptedMode = requestedMode ?? "keyword";

  try {
    await refreshProviderMode();
    const searchMode = requestedMode ?? providerCapabilities(
      providerState.phase,
      providerState.semanticIndex,
    ).searchMode;
    attemptedMode = searchMode;
    document.getElementById("note-list-heading").textContent = "Search results";
    const searchMethod = document.getElementById("search-method");
    searchMethod.textContent = searchMethodSummary(searchMode);
    searchMethod.classList.remove("hidden");
    const data = await api(
      `search?q=${encodeURIComponent(q)}&mode=${searchMode}`,
    );
    const results = sortSearchResults(data.results, searchMode);
    graphSearch = {
      query: q,
      resultIds: new Set(
        results.map((result) => Number(result.id)).filter((id) =>
          Number.isSafeInteger(id) && id > 0
        ),
      ),
      matchedIds: new Set(),
    };
    applySemanticNeighbourhoodBreadth();
    pageCount.textContent = String(results.length);
    pageCount.setAttribute(
      "aria-label",
      `${results.length} search result${results.length === 1 ? "" : "s"}`,
    );
    list.innerHTML = "";
    for (const [resultIndex, result] of results.entries()) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-list-button search-result";
      const title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = result.title;
      button.appendChild(title);
      const metric = searchResultMetric(result, resultIndex + 1);
      if (metric) {
        const relevance = document.createElement("span");
        relevance.className = "search-result-relevance";
        relevance.textContent = metric.text;
        relevance.title = metric.explanation;
        relevance.setAttribute(
          "aria-label",
          `${metric.text}. ${metric.explanation}`,
        );
        button.appendChild(relevance);
      }
      button.dataset.id = String(result.id);
      button.addEventListener("click", () => loadNote(result.id, button));
      li.appendChild(button);
      list.appendChild(li);
    }
    if (list.children.length === 0) {
      list.innerHTML =
        '<li style="color:#7a7f94;font-style:italic">No results</li>';
    }
  } catch (err) {
    clearGraphSearch();
    list.replaceChildren();
    const item = document.createElement("li");
    item.className = "search-error";
    const message = document.createElement("span");
    message.textContent = `Search error: ${err.message}`;
    item.appendChild(message);
    if (attemptedMode !== "keyword") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry with keyword search";
      retry.addEventListener("click", () => doSearch(q, "keyword"));
      item.appendChild(retry);
    }
    list.appendChild(item);
  } finally {
    searchInput.disabled = false;
  }
}

// --- Ingest with SSE progress ---

const ingestSourceType = document.getElementById("ingest-source-type");
const ingestInput = document.getElementById("ingest-input");
const ingestStages = document.getElementById("ingest-stages");
const ingestFileInput = document.getElementById("ingest-file");
const ingestTitleInput = document.getElementById("ingest-title");
const trustedBatchControls = document.getElementById(
  "trusted-batch-controls",
);
const trustedBatchConfirmationInput = document.getElementById(
  "trusted-batch-confirmation",
);
const ingestPlaceholders = {
  auto: "Paste source text, a YouTube ID, or a URL...",
  text: "Paste source text...",
  video: "Paste a YouTube video ID or URL...",
  playlist: "Paste a YouTube playlist ID or URL...",
  "trusted-batch": "Paste one YouTube video ID or URL per line...",
};

function isTrustedBatchMode() {
  return ingestSourceType.value === "trusted-batch";
}

function renderIngestMode() {
  const automatic = isTrustedBatchMode();
  ingestInput.placeholder = ingestPlaceholders[ingestSourceType.value];
  document.getElementById("ingest-input-label").textContent = automatic
    ? "Trusted YouTube videos · one ID or URL per line"
    : "Source text, YouTube link, or URL";
  document.getElementById("source-file-row").classList.toggle(
    "hidden",
    automatic,
  );
  document.getElementById("ingest-title-label").classList.toggle(
    "hidden",
    automatic,
  );
  ingestTitleInput.classList.toggle("hidden", automatic);
  trustedBatchControls.classList.toggle("hidden", !automatic);
  document.getElementById("ingest-final-step-title").textContent = automatic
    ? "Apply validated changes"
    : "Ready for review";
  document.getElementById("ingest-final-step-detail").textContent = automatic
    ? "No proposal-by-proposal review"
    : "Nothing changes automatically";
  document.getElementById("ingest-progress-note").textContent = automatic
    ? "Stop safely and submit the same list to resume; completed sources are skipped."
    : "Completed proposals remain available in Review.";
  document.getElementById("ingest-btn").textContent = automatic
    ? "Start automatic batch"
    : "Prepare for review";

  if (automatic) {
    ingestFileInput.value = "";
    document.getElementById("ingest-file-name").textContent = "";
    let phrase = "the confirmation shown after adding videos";
    try {
      phrase = trustedBatchConfirmation(
        parseTrustedVideoBatch(ingestInput.value).length,
      );
    } catch { /* an empty list has no confirmation yet */ }
    document.getElementById("trusted-batch-confirmation-phrase").textContent =
      phrase;
  }
}

function renderIngestProgress(stage) {
  const progress = ingestProgress(stage);
  for (const step of ingestStages.querySelectorAll("[data-ingest-step]")) {
    step.dataset.state = progress[step.dataset.ingestStep];
  }
}

function resetIngestProgress() {
  if (ingestInput.disabled) return;
  renderIngestProgress(null);
  document.getElementById("ingest-status").textContent = "";
}

addSourceButton.addEventListener("click", () => {
  const file = document.getElementById("ingest-file").files?.[0];
  if (shellState.sourceOpen && !ingestInput.value.trim() && !file) {
    resetIngestProgress();
  }
});
ingestInput.addEventListener("input", () => {
  resetIngestProgress();
  renderIngestMode();
});

ingestSourceType.addEventListener("change", () => {
  trustedBatchConfirmationInput.value = "";
  renderIngestMode();
  resetIngestProgress();
});

renderIngestMode();

document.getElementById("ingest-btn").addEventListener("click", async () => {
  const input = ingestInput;
  const titleInput = ingestTitleInput;
  const fileInput = ingestFileInput;
  const status = document.getElementById("ingest-status");
  const source = input.value.trim();
  const sourceType = ingestSourceType.value;
  const automatic = sourceType === "trusted-batch";
  const title = titleInput.value.trim();
  const file = fileInput.files?.[0];
  if (!source && !file) return;
  let trustedUrls = [];
  if (automatic) {
    try {
      trustedUrls = parseTrustedVideoBatch(source);
      const expected = trustedBatchConfirmation(trustedUrls.length);
      if (trustedBatchConfirmationInput.value !== expected) {
        status.textContent = `Type “${expected}” exactly to start this batch.`;
        trustedBatchConfirmationInput.focus();
        return;
      }
    } catch (err) {
      status.textContent = err.message;
      return;
    }
  }
  if (source && file) {
    status.textContent = "Choose a file or paste a source, not both.";
    return;
  }

  input.disabled = true;
  titleInput.disabled = true;
  ingestSourceType.disabled = true;
  fileInput.disabled = true;
  trustedBatchConfirmationInput.disabled = true;
  document.getElementById("ingest-btn").disabled = true;
  const requestController = new AbortController();
  activeIngestController = requestController;
  ingestCancelButton.disabled = false;
  ingestCancelButton.classList.remove("hidden");
  renderIngestProgress("ingesting");
  const finishOperation = beginOperation(
    automatic
      ? "Running the trusted source batch…"
      : "Preparing the source for review…",
    status,
  );

  let completed = false;
  let stagedProposalId = null;
  let ingestWarning = null;
  let batchSummary = null;

  try {
    const classifiedSource = automatic || file
      ? null
      : classifyIngestSource(source, sourceType);
    const endpoint = automatic
      ? "/api/ingest/batch"
      : file
      ? "/api/ingest/file"
      : classifiedSource.kind === "playlist"
      ? "/api/ingest/playlist"
      : "/api/ingest";
    let request;
    if (automatic) {
      request = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: trustedUrls,
          reviewMode: "automatic",
          confirm: trustedBatchConfirmationInput.value,
        }),
      };
    } else if (file) {
      const form = new FormData();
      form.set("file", file);
      if (title) form.set("title", title);
      request = { method: "POST", body: form };
    } else {
      const body = classifiedSource.kind === "text"
        ? { text: classifiedSource.value, ...(title ? { title } : {}) }
        : { url: classifiedSource.value };
      request = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
    }
    request.signal = requestController.signal;
    const res = await fetch(endpoint, request);

    await consumeSse(res, async (data) => {
      if (data.stage === "warning") ingestWarning = data.error;
      if (data.stage !== "warning" && data.stage !== "error") {
        renderIngestProgress(data.stage);
      }
      const labels = {
        ingesting: "Downloading or reading source...",
        ingested: "Source ready",
        extracting: "Extracting durable knowledge...",
        distilling: data.title,
        distilled: "Candidate pages prepared",
        integrating: "Comparing with the compiled wiki...",
        rewriting: data.total
          ? `Evolving page ${data.current} of ${data.total}: ${data.title}`
          : "Evolving existing pages...",
        batch_started:
          `Automatic batch started · ${data.total} trusted sources · ${data.providerMode} provider`,
        batch_source: `Reading source ${data.current} of ${data.total}...`,
        automatic_proposal:
          `Applying source ${data.current} of ${data.total} (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)...`,
        automatic_applied:
          `Applied source ${data.current} of ${data.total} (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)`,
        batch_skipped:
          `Skipped source ${data.current} of ${data.total}: already applied`,
        synthesizing:
          `Comparing ${data.pageCount} pages across all trusted sources...`,
        synthesis_progress:
          `Reviewing cross-source candidate group ${data.current} of ${data.total}...`,
        batch_complete:
          `Batch complete · ${data.applied} applied · ${data.skipped} already present`,
        proposal:
          `Ready for review (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)`,
        warning: data.error,
        done: ingestWarning
          ? `Completed with warning: ${ingestWarning}`
          : batchSummary
          ? `Batch complete · ${batchSummary.applied} applied · ${batchSummary.skipped} already present`
          : stagedProposalId
          ? "Proposal ready for review. No wiki pages changed yet."
          : `${data.notes?.length ?? 0} existing pages found.`,
        error: data.error,
      };
      status.textContent = labels[data.stage] ?? data.stage;
      if (data.stage === "proposal") {
        stagedProposalId = data.proposal?.id;
        updateShell({ type: "close-source" });
        await openReviewWorkspace(stagedProposalId);
      }
      if (data.stage === "batch_complete") batchSummary = data;
      if (data.stage === "done") {
        completed = true;
        if (!stagedProposalId) {
          await loadNoteList();
          await loadGraph();
        }
        await refreshShellCounts();
      }
      if (data.stage === "error") throw new Error(data.error);
    });
  } catch (err) {
    status.textContent = requestController.signal.aborted
      ? "Stop requested. Completed sources and proposals are preserved; submit the same input to resume."
      : automatic
      ? `Automatic batch stopped: ${err.message}`
      : `Could not prepare source: ${err.message}`;
  } finally {
    finishOperation();
    if (activeIngestController === requestController) {
      activeIngestController = null;
    }
    ingestCancelButton.classList.add("hidden");
    ingestCancelButton.disabled = false;
    input.disabled = false;
    titleInput.disabled = false;
    ingestSourceType.disabled = false;
    fileInput.disabled = false;
    trustedBatchConfirmationInput.disabled = false;
    document.getElementById("ingest-btn").disabled = !providerCapabilities(
      providerState.phase,
    ).modelActions;
    if (completed) {
      input.value = "";
      titleInput.value = "";
      fileInput.value = "";
      trustedBatchConfirmationInput.value = "";
      document.getElementById("ingest-file-name").textContent = "";
    }
    renderIngestMode();
  }
});

ingestCancelButton.addEventListener("click", () => {
  if (!activeIngestController) return;
  ingestCancelButton.disabled = true;
  document.getElementById("ingest-status").textContent =
    "Stopping after the current source or model step...";
  activeIngestController.abort();
});

document.getElementById("ingest-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  document.getElementById("ingest-file-name").textContent = file
    ? file.name
    : "";
  resetIngestProgress();
});

document.getElementById("ingest-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    document.getElementById("ingest-btn").click();
  }
});
document.getElementById("ingest-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("ingest-btn").click();
  }
});

// --- Graph (d3-force) ---

async function loadGraph() {
  const data = await api("graph");
  rawGraphData = {
    nodes: [...(data.nodes ?? [])].sort((left, right) => left.id - right.id),
    links: (data.links ?? []).map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.kind ?? "semantic",
      similarity: l.similarity,
      relationships: l.relationships,
    })).sort((left, right) =>
      Number(left.kind === "explicit") - Number(right.kind === "explicit") ||
      left.source - right.source || left.target - right.target
    ),
  };
  graphUnavailable = false;
  applySemanticNeighbourhoodBreadth();
}

const tooltip = select("#graph-tooltip");

function renderGraph() {
  const svg = select(graphElement);
  refreshGraphFocusHighlight = () => {};
  refreshGraphPositions = () => {};
  revealGraphNode = (_id) => {};
  fitGraphToViewport = () => {};
  tooltip.classed("hidden", true);
  const panel = document.getElementById("graph-panel");
  if (panel.classList.contains("hidden")) return;
  simulation?.stop();
  const width = Math.max(graphElement.clientWidth, 1);
  const height = Math.max(graphElement.clientHeight, 1);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();
  renderGraphPageList();
  svg.on("click.graph-focus", (event) => {
    if (event.target === svg.node()) clearGraphFocus();
  });

  if (graphUnavailable) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("class", "placeholder-text")
      .text("Connections are temporarily unavailable");
    return;
  }

  if (graphData.nodes.length === 0) {
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("class", "placeholder-text")
      .text(
        graphSearch
          ? `No graph pages match “${graphSearch.query}”`
          : "No notes yet",
      );
    return;
  }

  const g = svg.append("g");
  let transform = zoomIdentity;
  let hoveredId = null;
  let keyboardId = null;
  let highlightedIds = new Set();
  let previousLabelIds = new Set();
  const sims = graphData.links
    .filter((link) => link.kind === "semantic")
    .map((link) => link.similarity ?? 0.6);
  const minSim = sims.length ? Math.min(...sims) : 0.6;
  const maxSim = sims.length ? Math.max(...sims) : 0.6;
  const similarityRange = semanticSimilarityRange(graphData.links);

  const zoomBehavior = zoom()
    .scaleExtent([0.01, 4])
    .on("start", (event) => {
      if (event.sourceEvent) graphAutoFitPending = false;
    })
    .on("zoom", (event) => {
      transform = event.transform;
      g.attr("transform", event.transform);
      updateGraphLabels();
      tooltip.classed("hidden", true);
    });
  svg.property("__zoom", zoomIdentity);
  svg.call(zoomBehavior);

  const link = g.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(graphData.links)
    .join("line")
    .attr("class", (d) => `link link-${d.kind}`)
    .attr("stroke", (d) => {
      if (d.kind === "explicit") return "#7bb8ff";
      const sim = d.similarity ?? 0.6;
      const t = (sim - minSim) / ((maxSim - minSim) || 1);
      const r = Math.round(130 - 50 * t);
      const gg = Math.round(140 - 50 * t);
      const b = Math.round(155 + 45 * t);
      return `rgb(${r}, ${gg}, ${b})`;
    })
    .attr("stroke-width", (d) => {
      if (d.kind === "explicit") return 2.6;
      const sim = d.similarity ?? 0.6;
      return 1.0 + 2.0 * ((sim - minSim) / ((maxSim - minSim) || 1));
    })
    .attr("stroke-opacity", (d) => {
      if (d.kind === "explicit") return 0.9;
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
    .classed(
      "is-search-match",
      (datum) => graphSearch?.matchedIds.has(datum.id) ?? false,
    )
    .attr("r", nodeRadius)
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr(
      "aria-label",
      (d) =>
        `Focus ${d.title}${
          graphSearch?.matchedIds.has(d.id) ? " (direct search result)" : ""
        }`,
    )
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      event.stopPropagation();
      graphAutoFitPending = false;
      setGraphFocus(d.id);
    })
    .on("keydown", (event, d) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      graphAutoFitPending = false;
      setGraphFocus(d.id);
    })
    .on("focus", (event, d) => {
      graphAutoFitPending = false;
      keyboardId = d.id;
      revealGraphNode(d.id);
      refreshGraphFocusHighlight();
      showGraphTooltip(event, d);
    })
    .on("blur", () => {
      keyboardId = null;
      refreshGraphFocusHighlight();
      tooltip.classed("hidden", true);
    })
    .on("mouseover", (event, d) => {
      hoveredId = d.id;
      refreshGraphFocusHighlight();
      showGraphTooltip(event, d);
    })
    .on("mousemove", showGraphTooltip)
    .on("mouseout", () => {
      hoveredId = null;
      refreshGraphFocusHighlight();
      tooltip.classed("hidden", true);
    });

  // Titles live outside the zoomed layer so their font stays readable in pixels.
  const label = svg.append("g")
    .attr("class", "graph-labels")
    .attr("aria-hidden", "true")
    .selectAll("text")
    .data(graphData.nodes)
    .join("text")
    .attr("class", "label")
    .classed(
      "is-search-match",
      (datum) => graphSearch?.matchedIds.has(datum.id) ?? false,
    )
    .style("pointer-events", "none");

  const measurement = document.createElement("canvas").getContext("2d");
  measurement.font = `500 13px ${getComputedStyle(graphElement).fontFamily}`;
  const measure = (text) => measurement.measureText(text).width;
  const labelMetrics = new Map();
  let measuredWidth = 0;

  function updateGraphLabels() {
    const viewport = graphElement.viewBox.baseVal;
    const maxWidth = Math.min(180, viewport.width - 24);
    if (measuredWidth !== maxWidth) {
      measuredWidth = maxWidth;
      label.each(function (datum) {
        const lines = graphLabelLines(datum.title, measure, maxWidth);
        labelMetrics.set(datum.id, {
          width: Math.max(1, ...lines.map(measure)),
          height: Math.max(16, lines.length * 16),
        });
        select(this).selectAll("tspan").data(lines).join("tspan")
          .text((line) => line).attr(
            "dy",
            (_line, index) => index === 0 ? 0 : 16,
          );
      });
    }
    const activeId = hoveredId ?? keyboardId;
    const placements = graphLabelLayout(
      graphData.nodes.map((datum) => ({
        id: datum.id,
        x: transform.applyX(datum.x),
        y: transform.applyY(datum.y),
        radius: nodeRadius(datum) * transform.k,
        ...labelMetrics.get(datum.id),
        priority: datum.id === activeId
          ? 0
          : datum.id === graphFocusId
          ? 1
          : graphSearch?.matchedIds.has(datum.id)
          ? 2
          : highlightedIds.has(datum.id)
          ? 3
          : 4,
        degree: degree.get(datum.id) ?? 0,
      })),
      viewport.width,
      viewport.height,
      {
        previousIds: previousLabelIds,
        // Retain the configured threshold as a density change, never a blank map.
        padding: transform.k > uiConfig.labelZoomThreshold ? 4 : 10,
      },
    );
    previousLabelIds = new Set(placements.keys());
    label.each(function (datum) {
      const box = placements.get(datum.id);
      const text = select(this).style("display", box ? null : "none");
      if (!box) return;
      text.attr("x", box.x).attr("y", box.y + 12);
      text.selectAll("tspan").attr("x", box.x);
    });
  }

  function showGraphTooltip(event, datum) {
    const rect = event.currentTarget.getBoundingClientRect();
    tooltip.classed("hidden", false).text(datum.title);
    const box = tooltip.node().getBoundingClientRect();
    const x = event.clientX ?? rect.right;
    const y = event.clientY ?? rect.bottom;
    tooltip.style(
      "left",
      `${Math.max(8, Math.min(innerWidth - box.width - 8, x + 12))}px`,
    )
      .style(
        "top",
        `${Math.max(8, Math.min(innerHeight - box.height - 8, y + 12))}px`,
      );
  }

  revealGraphNode = (id) => {
    const datum = graphData.nodes.find((item) => item.id === id);
    if (!datum || !Number.isFinite(datum.x) || !Number.isFinite(datum.y)) {
      return;
    }
    const viewport = graphElement.viewBox.baseVal;
    const x = transform.applyX(datum.x), y = transform.applyY(datum.y);
    if (
      x >= 40 && x <= viewport.width - 40 && y >= 40 &&
      y <= viewport.height - 40
    ) return;
    svg.call(
      zoomBehavior.transform,
      zoomIdentity
        .translate(
          viewport.width / 2 - datum.x * transform.k,
          viewport.height / 2 - datum.y * transform.k,
        )
        .scale(transform.k),
    );
  };
  refreshGraphPositions = updateGraphPositions;

  function endpointId(endpoint) {
    return endpoint && typeof endpoint === "object" ? endpoint.id : endpoint;
  }

  function highlightNeighbourhood(hoveredId) {
    const connectedIds = graphFocusNodeIds(
      graphData.nodes,
      graphData.links,
      hoveredId,
    );
    highlightedIds = connectedIds;

    link
      .classed(
        "is-highlighted",
        (edge) =>
          endpointId(edge.source) === hoveredId ||
          endpointId(edge.target) === hoveredId,
      )
      .classed("is-muted", (edge) =>
        endpointId(edge.source) !== hoveredId &&
        endpointId(edge.target) !== hoveredId);
    node
      .classed(
        "is-focused",
        (datum) => datum.id === hoveredId || datum.id === graphFocusId,
      )
      .classed(
        "is-connected",
        (datum) => datum.id !== hoveredId && connectedIds.has(datum.id),
      )
      .classed(
        "is-muted",
        (datum) => !connectedIds.has(datum.id) && datum.id !== graphFocusId,
      );
    label
      .classed(
        "is-highlighted",
        (datum) => connectedIds.has(datum.id) || datum.id === graphFocusId,
      )
      .classed(
        "is-muted",
        (datum) => !connectedIds.has(datum.id) && datum.id !== graphFocusId,
      );
  }

  function clearNeighbourhoodHighlight() {
    highlightedIds = new Set();
    link.classed("is-highlighted is-muted", false);
    node.classed("is-focused is-connected is-muted", false);
    label.classed("is-highlighted is-muted", false);
  }

  refreshGraphFocusHighlight = () => {
    const activeId = hoveredId ?? keyboardId ?? graphFocusId;
    if (activeId === null) clearNeighbourhoodHighlight();
    else highlightNeighbourhood(activeId);
    updateGraphLabels();
  };
  refreshGraphFocusHighlight();

  node.call(
    drag()
      .on("start", (event, d) => {
        graphAutoFitPending = false;
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

  function updateGraphPositions() {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y);
    updateGraphLabels();
  }

  fitGraphToViewport = () => {
    if (graphData.nodes.length === 0) return;
    const viewport = graphElement.viewBox.baseVal;
    const transform = graphFitTransform(
      graphData.nodes,
      viewport.width,
      viewport.height,
    );
    svg.call(
      zoomBehavior.transform,
      zoomIdentity.translate(transform.x, transform.y).scale(transform.k),
    );
  };

  function fitSettledGraph() {
    if (!graphAutoFitPending || !graphMaximized) return;
    graphAutoFitPending = false;
    fitGraphToViewport();
  }

  simulation = forceSimulation(graphData.nodes)
    .randomSource(seededGraphRandom())
    .force(
      "link",
      forceLink(graphData.links)
        .id((d) => d.id)
        .distance((edge) => graphLinkDistance(edge, similarityRange))
        .strength((edge) => graphLinkStrength(edge, similarityRange)),
    )
    .force("charge", forceManyBody().strength(-170))
    .force(
      "collision",
      forceCollide().radius((datum) => nodeRadius(datum) + 4).iterations(2),
    )
    .force("center", forceCenter(width / 2, height / 2))
    .on("tick", updateGraphPositions)
    .on("end", fitSettledGraph);

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    simulation.stop();
    let remainingTicks = 180;
    const settleBatch = () => {
      const batchSize = Math.min(24, remainingTicks);
      for (let tick = 0; tick < batchSize; tick += 1) simulation.tick();
      remainingTicks -= batchSize;
      updateGraphPositions();
      if (remainingTicks > 0 && simulation.alpha() > simulation.alphaMin()) {
        requestAnimationFrame(settleBatch);
      } else {
        fitSettledGraph();
      }
    };
    requestAnimationFrame(settleBatch);
  }
}

// --- Semantic neighbourhood breadth ---

const semanticNeighboursSlider = document.getElementById(
  "semantic-neighbours-slider",
);
const semanticNeighboursValue = document.getElementById(
  "semantic-neighbours-value",
);

semanticNeighboursSlider.addEventListener("input", () => {
  semanticNeighboursValue.textContent = semanticNeighboursSlider.value;
  applySemanticNeighbourhoodBreadth();
});

function applySemanticNeighbourhoodBreadth() {
  const breadth = Number(semanticNeighboursSlider.value);
  const semanticLinks = semanticNeighbourLinks(
    rawGraphData.nodes,
    rawGraphData.links,
    breadth,
  );
  const visibleGraph = graphSearch
    ? searchContextGraph(
      rawGraphData.nodes,
      semanticLinks,
      graphSearch.resultIds,
    )
    : {
      nodes: rawGraphData.nodes,
      links: semanticLinks,
      matchedIds: new Set(),
    };
  if (graphSearch) graphSearch.matchedIds = visibleGraph.matchedIds;
  graphData = {
    nodes: visibleGraph.nodes.map((node) => ({ ...node })),
    links: visibleGraph.links.map((link) => ({ ...link })),
  };
  if (
    graphFocusId !== null &&
    !graphData.nodes.some((node) => node.id === graphFocusId)
  ) {
    graphFocusId = null;
  }
  renderGraphSearchContext();
  renderGraphFocusContext();
  if (readerState.view === "connections") renderGraph();
}

function renderGraphSearchContext() {
  graphSearchContext.classList.toggle("hidden", graphSearch === null);
  graphSearchLegend.classList.toggle("hidden", graphSearch === null);
  if (!graphSearch) {
    graphSearchSummary.textContent = "";
    return;
  }
  const matches = graphSearch.matchedIds.size;
  const related = Math.max(0, graphData.nodes.length - matches);
  const matchLabel = `${matches} matching page${matches === 1 ? "" : "s"}`;
  const relatedLabel = `${related} directly connected page${
    related === 1 ? "" : "s"
  }`;
  graphSearchSummary.textContent =
    `“${graphSearch.query}” · ${matchLabel} · ${relatedLabel}`;
}

function renderGraphFocusContext() {
  renderGraphPageList();
  const focused = graphFocusId === null
    ? undefined
    : graphData.nodes.find((node) => node.id === graphFocusId);
  graphFocusContext.classList.toggle("hidden", focused === undefined);
  if (!focused) {
    graphFocusSummary.textContent = "";
    return;
  }
  const connectionCount = Math.max(
    0,
    graphFocusNodeIds(graphData.nodes, graphData.links, focused.id).size - 1,
  );
  graphFocusSummary.textContent =
    `Focused on “${focused.title}” · ${connectionCount} visible connection${
      connectionCount === 1 ? "" : "s"
    }`;
}

// --- Init ---

await fetchConfig();
void refreshProviderMode();
await refreshShellCounts();
const [initialNotes, initialGraph] = await Promise.allSettled([
  loadNoteList(),
  loadGraph(),
]);
if (initialNotes.status === "rejected") {
  const item = document.createElement("li");
  item.className = "note-list-error";
  item.textContent =
    "Wiki pages are temporarily unavailable. Refresh to retry.";
  document.getElementById("note-list").replaceChildren(item);
}
if (initialGraph.status === "rejected") {
  graphUnavailable = true;
}
async function restoreLocationState(initial = false) {
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "review") {
    const proposalId = Number(params.get("proposal"));
    await openReviewWorkspace(
      Number.isSafeInteger(proposalId) && proposalId > 0
        ? proposalId
        : undefined,
      false,
    );
    return;
  }

  setPrimaryWorkspace("wiki", false);
  const noteId = Number(params.get("note"));
  if (Number.isSafeInteger(noteId) && noteId > 0) {
    await loadNote(noteId, undefined, false);
    return;
  }
  if (
    initial && initialNotes.status === "fulfilled" && currentNotes.length > 0
  ) {
    const firstNote = [...currentNotes].sort((a, b) =>
      a.title.localeCompare(b.title)
    )[0];
    const url = new URL(location.href);
    url.searchParams.set("note", String(firstNote.id));
    history.replaceState({}, "", url);
    await loadNote(firstNote.id, undefined, false);
  } else clearReader(false);
}

await restoreLocationState(true);
globalThis.addEventListener("popstate", () => {
  restoreLocationState().catch((error) => {
    console.error("Could not restore workspace", error);
  });
});
new ResizeObserver(() => {
  if (simulation && readerState.view === "connections") {
    resizeGraphViewport();
  }
}).observe(graphElement);
