export function initialShellState() {
  return {
    navigationCollapsed: false,
    navigationOpen: false,
    pageListCollapsed: false,
    sourceOpen: false,
    toolsOpen: false,
  };
}

export function reduceShellState(state, action) {
  switch (action.type) {
    case "toggle-navigation":
      return {
        ...state,
        navigationOpen: !state.navigationOpen,
        sourceOpen: false,
        toolsOpen: false,
      };
    case "toggle-navigation-collapse":
      return {
        ...state,
        navigationCollapsed: !state.navigationCollapsed,
        navigationOpen: false,
      };
    case "toggle-page-list":
      return { ...state, pageListCollapsed: !state.pageListCollapsed };
    case "toggle-source":
      return {
        ...state,
        navigationOpen: false,
        sourceOpen: !state.sourceOpen,
        toolsOpen: false,
      };
    case "toggle-tools":
      return {
        ...state,
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
      return {
        ...state,
        navigationOpen: false,
        sourceOpen: false,
        toolsOpen: false,
      };
    default:
      return state;
  }
}

export function queueBadge(count, singular, plural) {
  const normalised = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return {
    hidden: normalised === 0,
    label: normalised === 0
      ? `No ${plural}`
      : `${normalised} ${normalised === 1 ? singular : plural}`,
    text: normalised > 99 ? "99+" : String(normalised),
  };
}
