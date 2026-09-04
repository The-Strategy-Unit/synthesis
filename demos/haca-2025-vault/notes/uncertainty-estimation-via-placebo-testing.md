---
title: "Uncertainty Estimation via Placebo Testing"
type: concept
tags: ["statistical inference", "placebo testing", "confidence intervals"]
links: ["Generalised Synthetic Control for Non-Normal Data", "Statistical Challenges in Small Control Unit Analysis"]
---

# Uncertainty Estimation via Placebo Testing

In the context of synthetic difference-in-differences analyses, uncertainty is estimated using a placebo test approach to construct confidence intervals and p-values. This method involves applying the estimation procedure to control units that did not receive the intervention, pretending they were treated. Since the true effect for these units is zero, a large estimated impact indicates inaccuracy in the method, while a small impact close to zero increases confidence in the results for the actual treated units.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

This process builds an empirical null distribution of effects. When multiple treated units exist, the procedure is run for all comparable units, and the effects and uncertainties are aggregated to produce an overall aggregate impact and uncertainty measure. This approach helps address statistical difficulties that arise when using many small control units to predict larger treated units, which can otherwise contribute to wide confidence intervals and reduced precision in estimates.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

## Related

- [[Generalised Synthetic Control for Non-Normal Data]]
- [[Statistical Challenges in Small Control Unit Analysis]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=pMjH9Az92xA>); SHA-256: `709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e` <!-- synthesis-source:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->
