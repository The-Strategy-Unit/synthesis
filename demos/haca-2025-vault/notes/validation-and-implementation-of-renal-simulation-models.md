---
title: "Validation and implementation of renal simulation models"
type: concept
tags: ["model validation", "data sources", "simulation accuracy"]
links: ["CKD progression modeling methodology", "Kidney replacement therapy capacity model"]
---

# Validation and implementation of renal simulation models

Both the CKD prevalence model and the Kidney Replacement Therapy capacity model have been validated against real-world data sources. The CKD model is validated using CVDPREVENT data, while the KRT capacity model is validated against UK Renal Registry (UKRR) data. The validation process involved building the models using data up to the end of 2022 and then testing their performance on a test dataset covering the years 2022 to 2025 to ensure accurate projection and reliability. The KRT model is implemented using the SimPy package, which includes an Excel user interface allowing users to design scenarios by selecting centres, regions, incidence profiles, and interventions. Results are pushed back into Python for visualisation, including plots of prevalence over time compared to baseline scenarios. The code and model are available on the Strategy Unit's GitHub.
<!-- synthesis-claim:e05a5dd71510e702ca6adb41c76103b873fca6e498e93a47d07c703183fb2fbf -->

## Related

- [[CKD progression modeling methodology]]
- [[Kidney replacement therapy capacity model]]

## Sources

- [HACA2025- Day 1- Improving System Flow](<https://www.youtube.com/watch?v=mj3F4XW1XTs>); SHA-256: `e05a5dd71510e702ca6adb41c76103b873fca6e498e93a47d07c703183fb2fbf` <!-- synthesis-source:e05a5dd71510e702ca6adb41c76103b873fca6e498e93a47d07c703183fb2fbf -->
