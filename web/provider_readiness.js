const MODES = new Set(["local", "remote"]);
const PHASES = new Set(["configured", "checking", "ready", "unavailable"]);

export function providerPresentation(state = {}) {
  const mode = MODES.has(state.mode) ? state.mode : "unknown";
  const phase = PHASES.has(state.phase) ? state.phase : "checking";
  const location = mode === "local"
    ? "Local AI"
    : mode === "remote"
    ? "Remote AI"
    : "AI provider";

  if (phase === "ready") {
    const semanticReady = state.semanticIndex?.complete === true;
    return {
      badgeMode: mode,
      text: `${location} · ready`,
      description: semanticReady
        ? "AI synthesis and semantic search are available. Wiki answers still require review."
        : "AI synthesis is available. Semantic search needs the local semantic index to be rebuilt or resumed.",
    };
  }
  if (phase === "unavailable") {
    return {
      badgeMode: "unavailable",
      text: "Knowledge-only · AI unavailable",
      description:
        "Existing wiki pages, evidence, review queues, and keyword search remain available.",
    };
  }
  if (phase === "configured") {
    return {
      badgeMode: "checking",
      text: `${location} · configured`,
      description:
        "Provider settings are configured but availability is not verified.",
    };
  }
  return {
    badgeMode: "checking",
    text: `${location} · checking`,
    description: "Checking configured model availability in the background.",
  };
}

export function providerCapabilities(phase, semanticIndex) {
  const modelActions = phase === "ready";
  const semanticSearch = modelActions && semanticIndex?.complete === true;
  return {
    modelActions,
    semanticSearch,
    searchMode: semanticSearch ? "semantic" : "keyword",
  };
}

export function providerEmptyState(phase) {
  return phase === "ready"
    ? { action: "add-source", label: "Add your first source" }
    : { action: "configure-provider", label: "Configure AI provider" };
}
