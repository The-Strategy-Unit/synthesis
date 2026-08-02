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

// --- Cited wiki query and reviewed write-back ---

const askModal = document.getElementById("ask-modal");
const askInput = document.getElementById("ask-input");
const askSubmit = document.getElementById("ask-submit");
const askSave = document.getElementById("ask-save");
const askStatus = document.getElementById("ask-status");
const askResult = document.getElementById("ask-result");
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
  askSubmit.disabled = busy;
  askSave.disabled = busy;
}

function clearReviewedAnswer() {
  reviewedWikiAnswer = null;
  askResult.classList.add("hidden");
  askSave.classList.add("hidden");
  document.getElementById("ask-answer").textContent = "";
  document.getElementById("ask-citations").replaceChildren();
}

function showWikiAnswer(question, data) {
  reviewedWikiAnswer = { question, ...data };
  document.getElementById("ask-answer").textContent = data.answer;
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
  setAskBusy(true);
  askStatus.textContent = "Saving the reviewed synthesis...";
  try {
    const data = await api("query/save", {
      method: "POST",
      body: JSON.stringify({
        question: reviewedWikiAnswer.question,
        answer: reviewedWikiAnswer.answer,
        citations: reviewedWikiAnswer.citations.map((citation) => citation.id),
        suggestedPage: reviewedWikiAnswer.suggestedPage,
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

// --- Provider onboarding ---

const providerModal = document.getElementById("provider-modal");
const providerForm = document.getElementById("provider-form");
const providerSave = document.getElementById("provider-save");
const providerStatus = document.getElementById("provider-status");
const llmKeyInput = document.getElementById("provider-llm-key");
const embeddingKeyInput = document.getElementById("provider-embed-key");

function setProviderBusy(busy) {
  for (const control of providerForm.elements) control.disabled = busy;
  providerSave.textContent = busy ? "Testing..." : "Test and save";
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
  updateKeyHint("provider-llm-key-hint", data.llmKeyStored);
  updateKeyHint("provider-embed-key-hint", data.embeddingKeyStored);
}

async function openProviderModal() {
  providerModal.classList.remove("hidden");
  providerStatus.textContent = "Loading provider settings...";
  setProviderBusy(true);
  try {
    const data = await api("provider");
    populateProviderForm(data);
    providerStatus.textContent = data.configured
      ? "Provider is configured."
      : "Complete the profile and test both connections.";
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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeProviderModal();
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
    action.textContent = page.action;
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

async function openSourcesModal() {
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
    sourcesList.querySelector("button")?.click();
  } catch (error) {
    sourcesStatus.textContent = error.message;
  }
}

document.getElementById("sources-open-btn").addEventListener(
  "click",
  openSourcesModal,
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
        `<li><a href="/?note=${
          encodeURIComponent(r.id)
        }" data-id="${r.id}" class="related-link">${
          escapeHtml(r.title)
        }</a></li>`
      ).join("") +
      "</ul>";
  }

  viewer.innerHTML = html + relatedHtml;

  viewer.querySelectorAll(".related-link").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (
        event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey ||
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

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

document.getElementById("ingest-btn").addEventListener("click", async () => {
  const input = document.getElementById("ingest-input");
  const titleInput = document.getElementById("ingest-title");
  const status = document.getElementById("ingest-status");
  const source = input.value.trim();
  const title = titleInput.value.trim();
  if (!source) return;

  input.disabled = true;
  titleInput.disabled = true;
  document.getElementById("ingest-btn").disabled = true;

  const sourceUrl = httpUrl(source);
  const isPlaylist = sourceUrl?.searchParams.has("list") ?? false;
  const endpoint = isPlaylist ? "/api/ingest/playlist" : "/api/ingest";
  const body = sourceUrl
    ? { url: source }
    : { text: source, ...(title ? { title } : {}) };
  let completed = false;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `Ingestion failed (${res.status})`);
    }

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
          distilled: "✨ Pages distilled",
          integrating: "🔗 Integrating with wiki...",
          integrated:
            `🔗 Integrated (${data.new} new, ${data.merge} merge, ${data.contradict} contradict)`,
          embedding: "📐 Embedding notes...",
          linking: "🕸️ Computing connections...",
          done: `✅ Done! ${data.notes?.length ?? 0} pages updated.`,
          error: `❌ ${data.error}`,
        };
        status.textContent = labels[data.stage] ?? data.stage;
        if (data.stage === "done" || data.stage === "error") {
          if (data.stage === "done") {
            completed = true;
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
    titleInput.disabled = false;
    document.getElementById("ingest-btn").disabled = false;
    if (completed) {
      input.value = "";
      titleInput.value = "";
    }
  }
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
    .on("mouseover", (_event, d) => {
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
const requestedNoteId = Number(
  new URLSearchParams(location.search).get("note"),
);
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
