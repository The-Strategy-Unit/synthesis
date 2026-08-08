import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom } from "d3-zoom";
import { classifyIngestSource } from "./ingest_source.js";
import {
  evidenceSummary,
  initialReaderState,
  reduceReaderState,
} from "./reader_workspace.js";
import { initialShellState, queueBadge, reduceShellState } from "./ui_shell.js";

// --- Config (fetched from backend) ---

let uiConfig = {
  labelZoomThreshold: 1.5,
  sliderMin: 0,
  sliderMax: 1,
  sliderStep: 0.025,
  defaultSimilarity: 0.75,
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.code = data.code;
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
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
      "open discovery",
      "open discoveries",
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

const rebuildCatalogButton = document.getElementById("rebuild-catalog-btn");

async function rebuildCatalog() {
  const confirmed = globalThis.confirm(
    "Rebuild the local catalog from authoritative vault files? " +
      "Accepted Markdown and sources stay intact. Embeddings, semantic " +
      "connections, pending proposals, and discovery review state are reset.",
  );
  if (!confirmed) return;

  rebuildCatalogButton.disabled = true;
  rebuildCatalogButton.textContent = "Rebuilding...";
  try {
    const data = await api("rebuild", {
      method: "POST",
      body: JSON.stringify({ confirm: "REBUILD" }),
    });
    await Promise.all([loadNoteList(), loadGraph()]);
    globalThis.alert(
      `Rebuilt ${data.rebuild.noteCount} wiki pages from ` +
        `${data.rebuild.sourceCount} sources. Keyword search and explicit ` +
        "wiki links are ready; semantic connections can be regenerated later.",
    );
  } catch (error) {
    globalThis.alert(error.message);
  } finally {
    rebuildCatalogButton.disabled = false;
    rebuildCatalogButton.textContent = "Rebuild";
  }
}

rebuildCatalogButton.addEventListener("click", rebuildCatalog);

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
    undoIngestButton.disabled = false;
    undoIngestButton.textContent = "Undo ingest";
  }
}

undoIngestButton.addEventListener("click", undoIngest);

// --- State ---

let currentNotes = [];
let graphData = { nodes: [], links: [] };
let rawGraphData = { nodes: [], links: [] };
let simulation = null;
let graphUnavailable = false;

// --- Note list ---

async function loadNoteList() {
  const data = await api("notes");
  currentNotes = data.notes ?? [];
  const list = document.getElementById("note-list");
  const pageCount = document.getElementById("page-count");
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
const noteContent = document.getElementById("note-content");
const evidencePanel = document.getElementById("evidence-panel");
const evidenceContent = document.getElementById("evidence-content");
const evidenceToggle = document.getElementById("evidence-toggle");
const evidenceClose = document.getElementById("evidence-close");
const graphPanel = document.getElementById("graph-panel");
const knowledgeLayout = document.getElementById("knowledge-layout");
const workspaceTitle = document.getElementById("workspace-title");
let readerState = initialReaderState();

function renderReaderWorkspace() {
  const pageVisible = readerState.view === "page";
  const hasSelection = readerState.selectedNoteId !== null;
  const evidenceVisible = pageVisible && hasSelection &&
    readerState.evidenceOpen;

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
  updateReader({ type: "show-connections" });
});
evidenceToggle.addEventListener("click", () => {
  updateReader({ type: "toggle-evidence" });
});
evidenceClose.addEventListener("click", () => {
  updateReader({ type: "hide-evidence" });
  evidenceToggle.focus();
});
document.getElementById("reader-add-source").addEventListener("click", () => {
  addSourceButton.click();
});
document.getElementById("wiki-nav-btn").addEventListener("click", () => {
  updateReader({ type: "show-page" });
});

renderReaderWorkspace();

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
  askModal.classList.remove("hidden");
  askInput.focus();
}

function closeAskModal() {
  askModal.classList.add("hidden");
}

function setAskBusy(busy) {
  askInput.disabled = busy;
  askAnswer.disabled = busy;
  askSubmit.disabled = busy;
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
    setAskBusy(false);
  }
}

document.getElementById("ask-open-btn").addEventListener("click", openAskModal);
document.getElementById("ask-close").addEventListener("click", closeAskModal);
askModal.addEventListener("click", (event) => {
  if (event.target === askModal) closeAskModal();
});
askSubmit.addEventListener("click", submitWikiQuestion);
askSave.addEventListener("click", saveReviewedWikiAnswer);
askInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitWikiQuestion();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAskModal();
});

// --- Ingest proposal review ---

const reviewModal = document.getElementById("review-modal");
const reviewStatus = document.getElementById("review-status");
const proposalList = document.getElementById("proposal-list");
const proposalDetail = document.getElementById("proposal-detail");
const proposalChanges = document.getElementById("proposal-changes");
const proposalApprove = document.getElementById("proposal-approve");
const proposalReject = document.getElementById("proposal-reject");
let selectedProposalId = null;
let proposalBusy = false;

function selectedProposalChanges() {
  return [...proposalChanges.querySelectorAll(".proposal-change")].flatMap(
    (item) => {
      const include = item.querySelector(".proposal-change-select");
      const body = item.querySelector(".proposal-body-edit");
      if (!include?.checked || !body) return [];
      return [{ index: Number(item.dataset.changeIndex), body: body.value }];
    },
  );
}

function updateProposalApprovalControls() {
  const count = selectedProposalChanges().length;
  proposalApprove.textContent = count > 0
    ? `Approve ${count} selected`
    : "Select changes to approve";
  proposalApprove.disabled = proposalBusy || count === 0;
}

function setProposalBusy(busy) {
  proposalBusy = busy;
  proposalReject.disabled = busy;
  proposalChanges.querySelectorAll("input, textarea").forEach((control) => {
    control.disabled = busy;
  });
  updateProposalApprovalControls();
}

function closeReviewModal() {
  reviewModal.classList.add("hidden");
  selectedProposalId = null;
}

function proposalChangeItem(change, index) {
  const item = document.createElement("li");
  item.className = "proposal-change";
  item.dataset.changeIndex = String(index);

  const heading = document.createElement("div");
  heading.className = "proposal-change-heading";
  const includeLabel = document.createElement("label");
  includeLabel.className = "proposal-change-include";
  const include = document.createElement("input");
  include.type = "checkbox";
  include.className = "proposal-change-select";
  include.checked = true;
  include.addEventListener("change", updateProposalApprovalControls);
  includeLabel.append(include, document.createTextNode("Include"));
  const action = document.createElement("span");
  action.className = "proposal-action";
  action.dataset.action = change.action;
  action.textContent = change.action;
  const title = document.createElement("strong");
  title.textContent = change.page.title;
  const type = document.createElement("small");
  type.textContent = change.page.type;
  heading.append(includeLabel, action, title, type);

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
  proposedPanel.append(proposedHeading, proposedBody);
  comparison.appendChild(proposedPanel);

  const metadata = document.createElement("p");
  const tags = change.page.tags?.length
    ? `Tags: ${change.page.tags.join(", ")}`
    : "No tags";
  const links = change.page.links?.length
    ? `Links: ${change.page.links.join(", ")}`
    : "No explicit links";
  const pages = change.sourcePages?.length
    ? `Source pages: ${change.sourcePages.join(", ")}`
    : null;
  metadata.textContent = [tags, links, pages].filter(Boolean).join(" · ");
  item.append(heading, comparison, metadata);

  if (change.pageId) {
    const current = document.createElement("button");
    current.type = "button";
    current.textContent = "Open current page";
    current.addEventListener("click", () => {
      closeReviewModal();
      loadNote(change.pageId);
    });
    item.appendChild(current);
  }
  return item;
}

function showProposal(proposal) {
  selectedProposalId = proposal.id;
  document.getElementById("proposal-source-title").textContent = proposal.source
    .title;
  document.getElementById("proposal-source-meta").textContent =
    `${proposal.source.sourceType} · ${proposal.changes.length} proposed change${
      proposal.changes.length === 1 ? "" : "s"
    }`;
  document.getElementById("proposal-source-summary").textContent = proposal
    .source.summary;
  proposalChanges.replaceChildren(
    ...proposal.changes.map(proposalChangeItem),
  );
  proposalDetail.classList.remove("hidden");
  setProposalBusy(false);
}

async function loadProposalDetail(proposalId, button) {
  selectedProposalId = proposalId;
  for (const item of proposalList.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  reviewStatus.textContent = "Loading proposed changes...";
  proposalDetail.classList.add("hidden");
  try {
    const data = await api(`proposals/${proposalId}`);
    if (selectedProposalId !== proposalId) return;
    showProposal(data.proposal);
    reviewStatus.textContent = "Review every change before deciding.";
  } catch (error) {
    if (selectedProposalId !== proposalId) return;
    reviewStatus.textContent = error.message;
  }
}

async function loadPendingProposals(preferredId) {
  proposalList.replaceChildren();
  proposalDetail.classList.add("hidden");
  selectedProposalId = null;
  reviewStatus.textContent = "Loading pending proposals...";
  const data = await api("proposals");
  const proposals = data.proposals ?? [];
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
    reviewStatus.textContent = "No changes are waiting for review.";
    return;
  }
  reviewStatus.textContent = `${proposals.length} proposal${
    proposals.length === 1 ? "" : "s"
  } waiting for review.`;
  const preferred = proposalList.querySelector('[data-preferred="true"]');
  (preferred ?? proposalList.querySelector("button"))?.click();
}

async function openReviewModal(preferredId) {
  reviewModal.classList.remove("hidden");
  try {
    await loadPendingProposals(preferredId);
  } catch (error) {
    reviewStatus.textContent = error.message;
  }
}

async function approveSelectedProposal() {
  if (!selectedProposalId) return;
  const changes = selectedProposalChanges();
  if (changes.length === 0) {
    reviewStatus.textContent = "Select at least one change to approve.";
    return;
  }
  setProposalBusy(true);
  reviewStatus.textContent = `Applying ${changes.length} reviewed change${
    changes.length === 1 ? "" : "s"
  }...`;
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
        closeReviewModal();
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
    setProposalBusy(false);
  }
}

async function rejectSelectedProposal() {
  if (!selectedProposalId) return;
  setProposalBusy(true);
  reviewStatus.textContent = "Rejecting proposal...";
  try {
    await api(`proposals/${selectedProposalId}/reject`, {
      method: "POST",
      body: "{}",
    });
    await loadPendingProposals();
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    setProposalBusy(false);
  }
}

document.getElementById("review-open-btn").addEventListener(
  "click",
  () => openReviewModal(),
);
document.getElementById("review-close").addEventListener(
  "click",
  closeReviewModal,
);
reviewModal.addEventListener("click", (event) => {
  if (event.target === reviewModal) closeReviewModal();
});
proposalApprove.addEventListener("click", approveSelectedProposal);
proposalReject.addEventListener("click", rejectSelectedProposal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeReviewModal();
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
let selectedDiscoveryId = null;

function setDiscoveryBusy(busy) {
  discoveriesScan.disabled = busy;
  discoveryInvestigate.disabled = busy;
  discoveryReject.disabled = busy;
  discoveryConfirm.disabled = busy;
}

function closeDiscoveriesModal() {
  discoveriesModal.classList.add("hidden");
  selectedDiscoveryId = null;
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
  document.getElementById("discovery-relationship").textContent = discovery
    .relationshipType.replaceAll("_", " ");
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
  discoveryInvestigate.disabled = discovery.status === "investigating";
  discoveryDetail.classList.remove("hidden");
}

async function loadDiscoveryDetail(discoveryId, button) {
  selectedDiscoveryId = discoveryId;
  for (const item of discoveriesList.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  discoveriesStatus.textContent = "Loading discovery evidence...";
  discoveryDetail.classList.add("hidden");
  try {
    const data = await api(`discoveries/${discoveryId}`);
    if (selectedDiscoveryId !== discoveryId) return;
    showDiscovery(data.discovery);
    discoveriesStatus.textContent =
      "Review the cited pages and sources before acting.";
  } catch (error) {
    if (selectedDiscoveryId !== discoveryId) return;
    discoveriesStatus.textContent = error.message;
  }
}

async function loadDiscoveries(preferredId) {
  discoveriesList.replaceChildren();
  discoveryDetail.classList.add("hidden");
  selectedDiscoveryId = null;
  discoveriesStatus.textContent = "Loading open discoveries...";
  const data = await api("discoveries");
  const discoveries = data.discoveries ?? [];
  setShellQueueCount(
    "discoveries-count",
    discoveries.length,
    "open discovery",
    "open discoveries",
  );
  for (const discovery of discoveries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "discovery-list-button";
    const relationship = document.createElement("span");
    relationship.textContent = discovery.relationshipType.replaceAll("_", " ");
    const pages = document.createElement("small");
    pages.textContent = discovery.pages.map((page) => page.title).join(" ↔ ");
    button.append(relationship, pages);
    button.addEventListener(
      "click",
      () => loadDiscoveryDetail(discovery.id, button),
    );
    if (discovery.id === preferredId) button.dataset.preferred = "true";
    item.appendChild(button);
    discoveriesList.appendChild(item);
  }
  if (discoveries.length === 0) {
    discoveriesStatus.textContent =
      "No open discoveries. Run a scan after adding connected evidence.";
    return;
  }
  discoveriesStatus.textContent = `${discoveries.length} connection${
    discoveries.length === 1 ? "" : "s"
  } awaiting review.`;
  const preferred = discoveriesList.querySelector('[data-preferred="true"]');
  (preferred ?? discoveriesList.querySelector("button"))?.click();
}

async function openDiscoveriesModal(preferredId) {
  discoveriesModal.classList.remove("hidden");
  try {
    await loadDiscoveries(preferredId);
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  }
}

async function scanDiscoveries() {
  setDiscoveryBusy(true);
  discoveriesStatus.textContent = "Scanning a bounded wiki neighborhood...";
  try {
    const data = await api("discoveries/generate", {
      method: "POST",
      body: "{}",
    });
    await loadDiscoveries(data.discoveries?.[0]?.id);
    if (!data.discoveries?.length) {
      discoveriesStatus.textContent =
        "No new evidence-backed connection was found.";
    }
  } catch (error) {
    discoveriesStatus.textContent = error.message;
  } finally {
    setDiscoveryBusy(false);
  }
}

async function reviewSelectedDiscovery(action) {
  if (!selectedDiscoveryId) return;
  setDiscoveryBusy(true);
  discoveriesStatus.textContent = `${action} discovery...`;
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
    setDiscoveryBusy(false);
    if (action === "investigate") discoveryInvestigate.disabled = true;
  }
}

document.getElementById("discoveries-open-btn").addEventListener(
  "click",
  () => openDiscoveriesModal(),
);
document.getElementById("discoveries-close").addEventListener(
  "click",
  closeDiscoveriesModal,
);
discoveriesModal.addEventListener("click", (event) => {
  if (event.target === discoveriesModal) closeDiscoveriesModal();
});
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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDiscoveriesModal();
});

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

function setProviderBusy(busy) {
  for (const control of providerForm.elements) control.disabled = busy;
  providerSave.textContent = busy ? "Testing..." : "Test and save";
  providerOllama.disabled = busy;
  providerDiagnose.disabled = busy;
}

function updateProviderMode(data) {
  const mode = data.mode ?? "unknown";
  providerModeBadge.dataset.mode = mode;
  providerModeBadge.textContent = mode === "local"
    ? "Local · Ollama-compatible"
    : mode === "remote"
    ? "Remote · BYOK"
    : "Provider unknown";
}

async function refreshProviderMode() {
  try {
    const data = await api("provider");
    updateProviderMode(data);
    return data;
  } catch {
    providerModeBadge.dataset.mode = "unavailable";
    providerModeBadge.textContent = "Knowledge-only · provider unavailable";
    return null;
  }
}

function updateKeyHint(id, stored) {
  document.getElementById(id).textContent = stored
    ? "A key is stored. Leave blank to keep it."
    : "Required for first-time setup.";
}

function populateProviderForm(data) {
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
  providerModal.classList.remove("hidden");
  providerStatus.textContent = "Loading provider settings...";
  setProviderBusy(true);
  try {
    const data = await api("provider");
    updateProviderMode(data);
    populateProviderForm(data);
    providerStatus.textContent = data.source === "environment"
      ? "Default provider is active. Run diagnostics to verify its models."
      : data.configured
      ? "Provider is configured."
      : "Complete the profile and test both connections.";
  } catch (error) {
    providerStatus.textContent = error.message;
  } finally {
    setProviderBusy(false);
  }
}

function useOllamaPreset() {
  providerForm.elements.displayName.value = "Local Ollama";
  providerForm.elements.llmApiBase.value = "http://localhost:11434/v1";
  providerForm.elements.llmModel.value = "qwen3.5:9b";
  providerForm.elements.embeddingApiBase.value = "http://localhost:11434/v1";
  providerForm.elements.embeddingModel.value = "qwen3-embedding:8b";
  if (!providerForm.elements.embeddingDimensions.value) {
    providerForm.elements.embeddingDimensions.value = 4096;
  }
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
  try {
    const data = await api("provider/diagnose", {
      method: "POST",
      body: "{}",
    });
    renderProviderDiagnostics(data.diagnostics);
    providerStatus.textContent = data.diagnostics.ready
      ? "Provider diagnostics passed."
      : "Resolve the listed model or compatibility issue, then diagnose again.";
  } catch (error) {
    providerStatus.textContent = error.message;
  } finally {
    setProviderBusy(false);
  }
}

function closeProviderModal() {
  providerModal.classList.add("hidden");
  llmKeyInput.value = "";
  embeddingKeyInput.value = "";
}

async function saveProvider(event) {
  event.preventDefault();
  if (!providerForm.reportValidity()) return;
  const fields = new FormData(providerForm);
  setProviderBusy(true);
  providerStatus.textContent = "Testing chat and embedding connections...";
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
    llmKeyInput.value = "";
    embeddingKeyInput.value = "";
    setProviderBusy(false);
  }
}

document.getElementById("provider-open-btn").addEventListener(
  "click",
  openProviderModal,
);
document.getElementById("provider-close").addEventListener(
  "click",
  closeProviderModal,
);
providerModal.addEventListener("click", (event) => {
  if (event.target === providerModal) closeProviderModal();
});
providerForm.addEventListener("submit", saveProvider);
providerOllama.addEventListener("click", useOllamaPreset);
providerDiagnose.addEventListener("click", diagnoseActiveProvider);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeProviderModal();
});

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
  schemaModal.classList.remove("hidden");
  schemaStatus.textContent = "Loading schema...";
  setSchemaBusy(true);
  try {
    const data = await api("schema");
    schemaInput.value = data.schema;
    schemaStatus.textContent = "Stored locally as schema.md.";
  } catch (error) {
    schemaStatus.textContent = error.message;
  } finally {
    setSchemaBusy(false);
  }
}

function closeSchemaModal() {
  schemaModal.classList.add("hidden");
}

async function saveSchema() {
  setSchemaBusy(true);
  schemaSave.textContent = "Saving...";
  schemaStatus.textContent = "Validating schema...";
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
schemaModal.addEventListener("click", (event) => {
  if (event.target === schemaModal) closeSchemaModal();
});
schemaSave.addEventListener("click", saveSchema);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSchemaModal();
});

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
  sourcesModal.classList.add("hidden");
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
  try {
    const data = await api(`sources/${sourceId}`);
    if (selectedSourceId !== sourceId) return;
    showSourceDetail(data);
    sourcesStatus.textContent = "";
  } catch (error) {
    if (selectedSourceId !== sourceId) return;
    sourceDetail.classList.add("hidden");
    sourcesStatus.textContent = error.message;
  }
}

async function openSourcesModal(preferredSourceId) {
  sourcesModal.classList.remove("hidden");
  sourcesList.replaceChildren();
  sourceDetail.classList.add("hidden");
  sourcesStatus.textContent = "Loading sources...";
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
sourcesModal.addEventListener("click", (event) => {
  if (event.target === sourcesModal) closeSourcesModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSourcesModal();
});

// --- Deterministic wiki health checks ---

const lintModal = document.getElementById("lint-modal");
const lintRefresh = document.getElementById("lint-refresh");
const lintAnalyze = document.getElementById("lint-analyze");
const lintStatus = document.getElementById("lint-status");
const lintSummary = document.getElementById("lint-summary");
const lintIssues = document.getElementById("lint-issues");
const lintAnalysis = document.getElementById("lint-analysis");
const lintAnalysisFindings = document.getElementById(
  "lint-analysis-findings",
);

function closeLintModal() {
  lintModal.classList.add("hidden");
}

function lintCount(label, count) {
  const item = document.createElement("span");
  item.className = "lint-count";
  item.textContent = `${count} ${label}`;
  return item;
}

async function runWikiLint() {
  lintRefresh.disabled = true;
  lintAnalyze.disabled = true;
  lintStatus.textContent = "Checking wiki structure and provenance...";
  lintSummary.classList.add("hidden");
  lintIssues.replaceChildren();
  lintAnalysis.classList.add("hidden");
  lintAnalysisFindings.replaceChildren();
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
    lintRefresh.disabled = false;
    lintAnalyze.disabled = false;
  }
}

async function analyzeWikiHealth() {
  lintRefresh.disabled = true;
  lintAnalyze.disabled = true;
  lintStatus.textContent =
    "Analyzing contradictions, stale claims, and gaps...";
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
    lintRefresh.disabled = false;
    lintAnalyze.disabled = false;
  }
}

document.getElementById("lint-open-btn").addEventListener("click", () => {
  lintModal.classList.remove("hidden");
  runWikiLint();
});
document.getElementById("lint-close").addEventListener("click", closeLintModal);
lintModal.addEventListener("click", (event) => {
  if (event.target === lintModal) closeLintModal();
});
lintRefresh.addEventListener("click", runWikiLint);
lintAnalyze.addEventListener("click", analyzeWikiHealth);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLintModal();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sourceLocation(source) {
  return source.sourcePages?.length
    ? `pages ${source.sourcePages.join(", ")}`
    : null;
}

function renderEvidence(page) {
  const summary = evidenceSummary(page);
  const sourceById = new Map(
    (page.sources ?? []).map((source) => [source.id, source]),
  );
  const claims = (page.claims ?? []).map((claim) => {
    const citedSources = (claim.sourceIds ?? []).map((sourceId) =>
      sourceById.get(sourceId)
    ).filter(Boolean);
    const citations = citedSources.length > 0
      ? citedSources.map((source) => {
        const location = sourceLocation(source);
        return `<button type="button" class="note-source-link" ` +
          `data-source-id="${source.id}">${escapeHtml(source.title)}` +
          `${location ? ` · ${escapeHtml(location)}` : ""}</button>`;
      }).join("")
      : "<span>No catalogued source</span>";
    return `<li><p>${escapeHtml(claim.text)}</p>` +
      `<div class="note-claim-citations">${citations}</div></li>`;
  }).join("");
  const sources = (page.sources ?? []).map((source) => {
    const detail = [source.action, sourceLocation(source)].filter(Boolean)
      .join(" · ");
    return `<li><button type="button" class="note-source-link" ` +
      `data-source-id="${source.id}">${escapeHtml(source.title)}</button>` +
      `<small>${escapeHtml(detail)}</small>` +
      `<p>${escapeHtml(source.summary)}</p></li>`;
  }).join("");
  const related = (page.related ?? []).map((item) =>
    `<li><a href="/?note=${encodeURIComponent(item.id)}" ` +
    `data-id="${item.id}" class="related-link">${
      escapeHtml(item.title)
    }</a><small>${
      item.kind === "explicit" ? "Reviewed wiki link" : "Semantic suggestion"
    }</small></li>`
  ).join("");

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
  if (updateHistory) {
    const url = new URL(location.href);
    if (url.searchParams.get("note") !== String(id)) {
      url.searchParams.set("note", String(id));
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
  const list = document.getElementById("note-list");

  list.innerHTML =
    '<li style="color:#7a7f94;font-style:italic">Searching...</li>';
  searchInput.disabled = true;

  try {
    const data = await api(`search?q=${encodeURIComponent(q)}`);
    list.innerHTML = "";
    for (const result of data.results ?? []) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-list-button";
      button.textContent = result.title;
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
    list.innerHTML =
      `<li style="color:#ff6b6b">Search error: ${err.message}</li>`;
  } finally {
    searchInput.disabled = false;
  }
}

// --- Ingest with SSE progress ---

const ingestSourceType = document.getElementById("ingest-source-type");
const ingestInput = document.getElementById("ingest-input");
const ingestPlaceholders = {
  auto: "Paste source text, a YouTube ID, or a URL...",
  text: "Paste source text...",
  video: "Paste a YouTube video ID or URL...",
  playlist: "Paste a YouTube playlist ID or URL...",
};

ingestSourceType.addEventListener("change", () => {
  ingestInput.placeholder = ingestPlaceholders[ingestSourceType.value];
});

document.getElementById("ingest-btn").addEventListener("click", async () => {
  const input = ingestInput;
  const titleInput = document.getElementById("ingest-title");
  const fileInput = document.getElementById("ingest-file");
  const status = document.getElementById("ingest-status");
  const source = input.value.trim();
  const sourceType = ingestSourceType.value;
  const title = titleInput.value.trim();
  const file = fileInput.files?.[0];
  if (!source && !file) return;
  if (source && file) {
    status.textContent = "Choose a file or paste a source, not both.";
    return;
  }

  input.disabled = true;
  titleInput.disabled = true;
  ingestSourceType.disabled = true;
  fileInput.disabled = true;
  document.getElementById("ingest-btn").disabled = true;

  let completed = false;
  let stagedProposalId = null;
  let ingestWarning = null;

  try {
    const classifiedSource = file
      ? null
      : classifyIngestSource(source, sourceType);
    const endpoint = file
      ? "/api/ingest/file"
      : classifiedSource.kind === "playlist"
      ? "/api/ingest/playlist"
      : "/api/ingest";
    let request;
    if (file) {
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
    const res = await fetch(endpoint, request);

    await consumeSse(res, async (data) => {
      if (data.stage === "warning") ingestWarning = data.error;
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
        proposal:
          `Ready for review (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)`,
        warning: data.error,
        done: ingestWarning
          ? `Completed with warning: ${ingestWarning}`
          : stagedProposalId
          ? "Proposal ready for review. No wiki pages changed yet."
          : `${data.notes?.length ?? 0} existing pages found.`,
        error: data.error,
      };
      status.textContent = labels[data.stage] ?? data.stage;
      if (data.stage === "proposal") {
        stagedProposalId = data.proposal?.id;
        updateShell({ type: "close-source" });
        await openReviewModal(stagedProposalId);
      }
      if (data.stage === "done") {
        completed = true;
        if (!stagedProposalId) {
          await loadNoteList();
          await loadGraph();
        }
      }
      if (data.stage === "error") throw new Error(data.error);
    });
  } catch (err) {
    status.textContent = `❌ ${err.message}`;
  } finally {
    input.disabled = false;
    titleInput.disabled = false;
    ingestSourceType.disabled = false;
    fileInput.disabled = false;
    document.getElementById("ingest-btn").disabled = false;
    if (completed) {
      input.value = "";
      titleInput.value = "";
      fileInput.value = "";
      document.getElementById("ingest-file-name").textContent = "";
    }
  }
});

document.getElementById("ingest-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  document.getElementById("ingest-file-name").textContent = file
    ? file.name
    : "";
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
    nodes: data.nodes ?? [],
    links: (data.links ?? []).map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.kind ?? "semantic",
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

  graphUnavailable = false;
  if (readerState.view === "connections") renderGraph();
}

const tooltip = select("#graph-tooltip");

function renderGraph() {
  const svg = select("#graph");
  const panel = document.getElementById("graph-panel");
  if (panel.classList.contains("hidden")) return;
  simulation?.stop();
  const width = Math.max(panel.clientWidth - 10, 320);
  const height = panel.clientHeight || panel.parentElement.clientHeight;
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();

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
      .text("No notes yet");
    return;
  }

  const g = svg.append("g");
  let currentZoom = 1;
  const sims = graphData.links
    .filter((link) => link.kind === "semantic")
    .map((link) => link.similarity ?? 0.6);
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
    .attr("r", nodeRadius)
    .attr("role", "button")
    .attr("tabindex", 0)
    .attr("aria-label", (d) => `Open ${d.title}`)
    .style("cursor", "pointer")
    .on("click", (_event, d) => loadNote(d.id))
    .on("keydown", (event, d) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadNote(d.id);
    })
    .on("mouseover", (_event, d) => {
      highlightNeighborhood(d.id);
      const visibleConnections = degree.get(d.id) ?? 0;
      const declaredConnections = graphData.links.filter((link) =>
        link.kind === "explicit" &&
        [endpointId(link.source), endpointId(link.target)].includes(d.id)
      ).length;
      tooltip
        .classed("hidden", false)
        .text(
          `${d.title} — ${declaredConnections} wiki links, ${
            visibleConnections - declaredConnections
          } semantic connections`,
        );
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
    .force(
      "link",
      forceLink(graphData.links).id((d) => d.id).distance((link) =>
        link.kind === "explicit" ? 65 : 90
      ),
    )
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
    .filter((l) => l.kind === "explicit" || (l.similarity ?? 0.6) >= threshold)
    .map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.kind,
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
await refreshProviderMode();
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
const requestedNoteId = Number(
  new URLSearchParams(location.search).get("note"),
);
if (Number.isSafeInteger(requestedNoteId) && requestedNoteId > 0) {
  await loadNote(requestedNoteId, undefined, false);
} else if (initialNotes.status === "fulfilled" && currentNotes.length > 0) {
  const firstNote = [...currentNotes].sort((a, b) =>
    a.title.localeCompare(b.title)
  )[0];
  const url = new URL(location.href);
  url.searchParams.set("note", String(firstNote.id));
  history.replaceState({}, "", url);
  await loadNote(firstNote.id, undefined, false);
}
globalThis.addEventListener("popstate", () => {
  const noteId = Number(new URLSearchParams(location.search).get("note"));
  if (Number.isSafeInteger(noteId) && noteId > 0) {
    loadNote(noteId, undefined, false);
  } else clearReader(false);
});
globalThis.addEventListener("resize", () => {
  if (simulation && readerState.view === "connections") renderGraph();
});
