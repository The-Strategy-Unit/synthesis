---
title: "Responsive layout techniques for Shiny dashboards"
type: concept
tags: ["css", "r-programming", "mobile-responsive"]
links: ["Custom CSS for Shiny application trust and design", "Accessibility testing for Shiny applications"]
---

# Responsive layout techniques for Shiny dashboards

User research on Shiny dashboards revealed that while users valued the data and charts, the user experience was poor, particularly on mobile devices. Issues included styling inconsistencies with the main website, unreadable fonts, overlapping elements, and a non-intuitive sidebar menu (burger button) that many users failed to discover. Analytics indicated that up to half of the users accessed the app via mobile. To address this, the development team shifted their design philosophy to make the dashboard look and feel more like a standard website, reducing the cognitive load required to navigate the tool.
<!-- synthesis-claim:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->

To create responsive dashboards, specific techniques in R and CSS are employed. In R, Plotly charts can be adjusted using conditional logic (if/else) to detect window size; if the screen is small, margins and fonts are reduced, or chart orientation is changed. For navigation, the `bslib` package's `layout_column_wrap` function allows elements, such as key statistic boxes, to reorient from a horizontal row on desktop to a vertical stack on mobile, enabling intuitive scrolling and click-through navigation without relying on side menus. In CSS, negative space is managed by setting a maximum width on a central content div, allowing margins to adjust automatically. Media queries are used to apply different styles based on screen width, such as changing the display value and padding for selector buttons on mobile. Flexbox is utilized to control layout direction, using media queries to switch flex-direction from row (desktop) to column (mobile) for elements like navigation bars.
<!-- synthesis-claim:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->

## Related

- [[Custom CSS for Shiny application trust and design]]
- [[Accessibility testing for Shiny applications]]

## Sources

- [HACA 2025 - Day 1 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=J9hsz7-iHUk>); SHA-256: `c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556` <!-- synthesis-source:c58a3c91b72e979fe0a029e84b6a0b7e4d6313653d3821e31ea33252ab81c556 -->
