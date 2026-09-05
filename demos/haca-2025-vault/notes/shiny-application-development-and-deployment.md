---
title: "Shiny Application Development and Deployment"
type: concept
tags: ["software development", "deployment", "data security"]
links: ["Interactive Shiny Dashboards for Cancer Audits", "Balancing Audit Consistency and Bespoke Requirements"]
---

# Shiny Application Development and Deployment

The development of NATCAN dashboards utilised a three-environment workflow to manage data sensitivity and application maturity. First, an on-premises, offline environment housed patient-level data from the National Disease Registration Service for analysis. Second, a development environment initially used dummy data to allow parallel development of application and analysis code. Once the structure was established, it was combined with aggregate data featuring small number suppression and deployed to shinyapps.io for restricted access review by project teams and funders. Finally, upon approval, the application moved to a public production environment without login requirements.
<!-- synthesis-claim:d53f9a84f652ab515a3f17430fbe1487d6591881fa8369df030fc6bea4047a77 -->

Deployment options were evaluated based on ease of use, cost, scalability, security, and customisation. Posit Connect was considered for its enterprise features but deemed costly. Shiny Server offered free self-hosting but required manual management. The selected platform was shinyapps.io, a cloud-based service by Posit, chosen for its ease of deployment and lack of server management requirements, despite limitations on scalability and usage hours on lower tiers. Refactoring efforts during the second phase aimed to make the app structure audit-agnostic, centralising common aspects like the user interface while localising audit-specific parameters and text.
<!-- synthesis-claim:d53f9a84f652ab515a3f17430fbe1487d6591881fa8369df030fc6bea4047a77 -->

## Related

- [[Interactive Shiny Dashboards for Cancer Audits]]
- [[Balancing Audit Consistency and Bespoke Requirements]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=YoCMf5Ctd2Y>); SHA-256: `d53f9a84f652ab515a3f17430fbe1487d6591881fa8369df030fc6bea4047a77` <!-- synthesis-source:d53f9a84f652ab515a3f17430fbe1487d6591881fa8369df030fc6bea4047a77 -->
