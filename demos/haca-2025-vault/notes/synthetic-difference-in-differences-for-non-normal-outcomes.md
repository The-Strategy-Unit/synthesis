---
title: "Synthetic Difference-in-Differences for Non-Normal Outcomes"
type: concept
tags: ["statistical methods", "synthetic difference-in-differences", "causal inference"]
links: ["Limitations of Classic Synthetic Difference-in-Differences", "Generalised Synthetic Control for Non-Normal Data"]
---

# Synthetic Difference-in-Differences for Non-Normal Outcomes

Synthetic Difference-in-Differences (SDID) is an impact evaluation technique that extends synthetic control methods by incorporating time weights to create a synthetic counterfactual. While classic SDID assumes normally distributed outcomes and units on the same scale, these assumptions often fail in healthcare data involving counts (e.g., A&E attendances) or rates (e.g., non-attendance rates), particularly when control units have vastly different scales or include zeros.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

To address these limitations, a modified SDID procedure was developed to handle non-Gaussian data types. This approach reframes the weight selection process as maximising the likelihood function for a specific statistical family rather than minimising squared residuals. For count data, the Poisson family is used, while the Binomial family is applied to rates. This generalised synthetic control method allows for robust estimation when data does not follow a normal distribution, resolving issues where standard weighting schemes break down due to scale mismatches or small counts.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

## Related

- [[Limitations of Classic Synthetic Difference-in-Differences]]
- [[Generalised Synthetic Control for Non-Normal Data]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=pMjH9Az92xA>); SHA-256: `709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e` <!-- synthesis-source:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->
