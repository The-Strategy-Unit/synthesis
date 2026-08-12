export function initialShellState() {
  return {
    navigationOpen: false,
    sourceOpen: false,
    toolsOpen: false,
  };
}

export function reduceShellState(state, action) {
  switch (action.type) {
    case "toggle-navigation":
      return {
        navigationOpen: !state.navigationOpen,
        sourceOpen: false,
        toolsOpen: false,
      };
    case "toggle-source":
      return {
        navigationOpen: false,
        sourceOpen: !state.sourceOpen,
        toolsOpen: false,
      };
    case "toggle-tools":
      return {
        navigationOpen: false,
        sourceOpen: false,
        toolsOpen: !state.toolsOpen,
      };
    case "close-navigation":
      return { ...state, navigationOpen: false };
    case "close-source":
      return { ...state, sourceOpen: false };
    case "close-tools":
      return { ...state, toolsOpen: false };
    case "dismiss":
      return initialShellState();
    default:
      return state;
  }
}

export function queueBadge(count, singular, plural) {
  const normalized = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return {
    hidden: normalized === 0,
    label: normalized === 0
      ? `No ${plural}`
      : `${normalized} ${normalized === 1 ? singular : plural}`,
    text: normalized > 99 ? "99+" : String(normalized),
  };
}
