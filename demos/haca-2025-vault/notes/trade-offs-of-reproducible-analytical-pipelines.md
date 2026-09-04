---
title: "Trade-offs of reproducible analytical pipelines"
type: concept
tags: ["reproducible research", "standardisation", "implementation challenges"]
links: ["Data Infrastructure and Versioning Challenges"]
---

# Trade-offs of reproducible analytical pipelines

While reproducible analytical pipelines (RAP) are valued for their rigor, they can introduce significant slowdowns in specific scenarios. An example cited involves correcting a single erroneous row among millions of data points. In a traditional spreadsheet environment, this might be a quick manual deletion, but in a reproducible pipeline, identifying and excluding that specific row requires a more complex, traceable process that can be time-consuming. The speaker acknowledges that while RAP saves time in the vast majority of cases, these edge cases highlight the friction between speed and reproducibility.
<!-- synthesis-claim:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->

A key benefit of the model is its consistent application across hospitals, defined by a standard set of SQL and procedures. However, managing the tension between this consistency and the need for local variation is challenging. Different hospitals may have unique characteristics that justify deviations from the standard model. The process involves balancing a well-defined, consistent methodology with the ability to allow meaningful, justified variations for specific local contexts. Additionally, there is a significant challenge in reconciling theoretical ideas about how data is provisioned with the pragmatic interpretations used by analysts and hospitals, as theoretical models may be deemed computationally prohibitive by operational teams.
<!-- synthesis-claim:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->

## Related

- [[Data Infrastructure and Versioning Challenges]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/Advancing Analytics](<https://www.youtube.com/watch?v=Yj57ivJpKU4>); SHA-256: `e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16` <!-- synthesis-source:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->
