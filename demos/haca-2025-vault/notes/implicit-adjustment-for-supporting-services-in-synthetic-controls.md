---
title: "Implicit Adjustment for Supporting Services in Synthetic Controls"
type: concept
tags: ["synthetic control", "confounding variables", "causal inference"]
links: ["Statistical Challenges in Small Control Unit Analysis", "Synthetic Difference-in-Differences for Non-Normal Outcomes"]
---

# Implicit Adjustment for Supporting Services in Synthetic Controls

Synthetic control methods do not directly adjust for differences in other supporting services, such as mental health provision, across different areas. Instead, they rely on matching trends in the pre-intervention period. If the trend in a treated area matches the synthetic control constructed from a weighted combination of control units, the method implicitly adjusts for existing differences in support services. This approach assumes that the pre-period trends adequately capture the relevant contextual factors.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

However, this implicit adjustment is agnostic to the specific types of services involved. A significant risk remains if other supporting services change around the same time as the intervention or during the study period. Such concurrent changes could confound the results, making it difficult to isolate the impact of the specific intervention being evaluated. Therefore, while the method handles baseline differences through trend matching, it requires careful monitoring of external changes that might violate the assumption of stable counterfactual trends.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

## Related

- [[Statistical Challenges in Small Control Unit Analysis]]
- [[Synthetic Difference-in-Differences for Non-Normal Outcomes]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=pMjH9Az92xA>); SHA-256: `709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e` <!-- synthesis-source:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->
