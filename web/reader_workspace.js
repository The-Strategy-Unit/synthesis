import { formatPageRanges } from "./review_workflow.js";

export function initialReaderState() {
  return {
    evidenceOpen: true,
    selectedNoteId: null,
    view: "page",
  };
}

export function reduceReaderState(state, action) {
  switch (action.type) {
    case "select-note":
      if (!Number.isSafeInteger(action.noteId) || action.noteId < 1) {
        return state;
      }
      return {
        evidenceOpen: true,
        selectedNoteId: action.noteId,
        view: "page",
      };
    case "show-page":
      return { ...state, view: "page" };
    case "show-connections":
      return { ...state, view: "connections" };
    case "toggle-evidence":
      return state.selectedNoteId === null
        ? state
        : { ...state, evidenceOpen: !state.evidenceOpen };
    case "hide-evidence":
      return { ...state, evidenceOpen: false };
    case "clear-note":
      return initialReaderState();
    default:
      return state;
  }
}

export function evidenceSummary(page) {
  const related = Array.isArray(page?.related) ? page.related : [];
  return {
    claimCount: Array.isArray(page?.claims) ? page.claims.length : 0,
    explicitLinkCount:
      related.filter((item) => item.kind === "explicit").length,
    semanticLinkCount:
      related.filter((item) => item.kind === "semantic").length,
    sourceCount: Array.isArray(page?.sources) ? page.sources.length : 0,
  };
}

export function compactEvidenceText(value, maxLength = 180) {
  const fullText = String(value ?? "").replace(/\s+/g, " ").trim();
  if (fullText.length <= maxLength) {
    return { fullText, preview: fullText, truncated: false };
  }
  const candidate = fullText.slice(0, maxLength + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const end = wordBoundary >= Math.floor(maxLength * 0.65)
    ? wordBoundary
    : maxLength;
  return {
    fullText,
    preview: `${fullText.slice(0, end).trimEnd()}…`,
    truncated: true,
  };
}

export function evidenceSourceLocation(source) {
  const pages = formatPageRanges(source?.sourcePages);
  return pages ? `pages ${pages}` : null;
}

export function evidenceActionLabel(action) {
  switch (action) {
    case "new":
      return "Added";
    case "merge":
      return "Updated";
    case "contradict":
      return "Conflict recorded";
    default:
      return null;
  }
}
