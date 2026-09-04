---
title: "Learning and troubleshooting CSS in Shiny apps"
type: concept
tags: ["css", "browser-tools", "troubleshooting"]
links: ["Custom CSS for Shiny application trust and design"]
---

# Learning and troubleshooting CSS in Shiny apps

Browser developer tools, accessible via right-clicking and selecting 'Inspect' (or 'Inspect Element'), allow users to view and modify the HTML and CSS of any webpage, including Shiny apps running in a viewer. This tool enables analysts to select specific elements on a page to see the applied CSS classes and attributes. Users can dynamically tick, untick, or edit CSS properties (such as colors) to see live changes, facilitating a practical learning process. This method allows analysts to reverse-engineer desired styles from existing websites (e.g., an organization's main website) and apply them to their own Shiny apps by copying the relevant CSS into a stylesheet linked via `tags$link`.
<!-- synthesis-claim:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->

Implementing custom CSS in Shiny apps can be complicated by styling conflicts with existing libraries, such as bslib. When multiple stylesheets apply to the same element, untangling which styles are active can be difficult. For example, styling a button might only affect its 'active' state if the specific class for that state is targeted, leaving the 'inactive' state unchanged. Analysts may need to carefully identify the correct classes to target. AI tools can assist in troubleshooting by analyzing screenshots of the inspection pane to explain why certain styles are not applying as expected, helping to resolve conflicts between custom CSS and library defaults.
<!-- synthesis-claim:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->

## Related

- [[Custom CSS for Shiny application trust and design]]

## Sources

- [HACA 2025 - Day 1 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=J9hsz7-iHUk>); SHA-256: `c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556` <!-- synthesis-source:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->
