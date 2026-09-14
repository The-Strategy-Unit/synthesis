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

export function searchAvailabilityPresentation(state = {}) {
  const phase = PHASES.has(state.phase) ? state.phase : "checking";
  const mode = MODES.has(state.mode) ? state.mode : "unknown";
  const semanticIndex = state.semanticIndex ?? {};
  const embedded = Number.isSafeInteger(semanticIndex.embedded)
    ? Math.max(0, semanticIndex.embedded)
    : 0;
  const total = Number.isSafeInteger(semanticIndex.total)
    ? Math.max(0, semanticIndex.total)
    : 0;

  if (phase === "ready" && semanticIndex.complete === true) {
    const coverage = total > 0 ? ` All ${total} wiki pages are indexed.` : "";
    const provider = mode === "remote"
      ? "Queries are sent to your configured remote embedding provider."
      : "Queries use your configured local embedding provider.";
    return {
      mode: "semantic",
      title: "Semantic search active",
      detail: `${coverage} ${provider}`.trim(),
      actionLabel: null,
    };
  }

  if (phase === "ready") {
    const progress = total > 0
      ? ` ${embedded} of ${total} wiki pages are indexed.`
      : " The semantic index has not been built for this embedding model.";
    return {
      mode: "keyword",
      title: "Keyword search active",
      detail:
        `AI is ready, but the semantic index is incomplete.${progress} Searches stay on-device until indexing finishes.`,
      actionLabel: embedded > 0
        ? "Resume semantic index"
        : "Build semantic index",
    };
  }

  if (phase === "unavailable") {
    return {
      mode: "keyword",
      title: "Keyword search active",
      detail: "AI is unavailable, so searches use the on-device keyword index.",
      actionLabel: null,
    };
  }

  return {
    mode: "keyword",
    title: "Checking semantic search",
    detail:
      "Checking the AI provider and semantic index. Keyword search remains available on-device.",
    actionLabel: null,
  };
}

export function providerEmptyState(phase) {
  return phase === "ready"
    ? { action: "add-source", label: "Add your first source" }
    : { action: "configure-provider", label: "Configure AI provider" };
}

export function ollamaPreset(dimensions = 768) {
  const embeddingDimensions = Number.isSafeInteger(dimensions) &&
      dimensions >= 64
    ? dimensions
    : 768;
  return {
    displayName: "Local Ollama",
    llmApiBase: "http://localhost:11434/v1",
    llmModel: "qwen3.6:27b",
    embeddingApiBase: "http://localhost:11434/v1",
    embeddingModel: "nomic-embed-text-v2-moe:latest",
    embeddingDimensions,
  };
}
