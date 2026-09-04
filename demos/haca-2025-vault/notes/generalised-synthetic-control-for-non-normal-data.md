---
title: "Generalised Synthetic Control for Non-Normal Data"
type: concept
tags: ["statistical modelling", "likelihood functions", "placebo testing"]
links: ["Synthetic Difference-in-Differences for Non-Normal Outcomes", "Uncertainty Estimation via Placebo Testing"]
---

# Generalised Synthetic Control for Non-Normal Data

Generalised synthetic control methods adapt the weight selection process to accommodate various data distributions by maximising the likelihood function appropriate for the specific data type. This allows the method to be applied to any statistical family, such as Poisson for count data or Binomial for rates, rather than being restricted to the Gaussian family. By changing the likelihood function, the optimisation algorithm can correctly handle the distributional properties of outcomes that do not follow a normal distribution.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

The implementation of this approach involved developing a sequence of functions that require only the dataset and treated units as inputs, supporting both one-sided and two-sided inferential statistics. Uncertainty, including p-values and confidence intervals, is estimated using a placebo test approach. This involves pretending that control units received the treatment and assessing the estimated impact for those units to build an empirical null distribution. While the current implementation successfully progresses from Gaussian to Poisson and Binomial models, it does not yet adjust for overdispersion, which remains a goal for future work involving negative binomial models.
<!-- synthesis-claim:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->

## Related

- [[Synthetic Difference-in-Differences for Non-Normal Outcomes]]
- [[Uncertainty Estimation via Placebo Testing]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=pMjH9Az92xA>); SHA-256: `709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e` <!-- synthesis-source:709e547f8fa6aef75ab7c7a19d39358d2b068a13055e48854f5f03b236c49d6e -->
