---
title: "Contextual limitations and infrastructure mismatches"
type: concept
tags: ["context", "data quality", "deployment challenges"]
links: ["Risk prediction model limitations", "Data quality in emergency care analytics"]
relationships: [{"target":"Data quality in emergency care analytics","type":"shared_constraint","explanation":"The 'Contextual limitations and infrastructure mismatches' page highlights that AI systems often fail due to mismatches between training environments and deployment infrastructure, and that data quality issues like missing ethnicity (26%) and frailty data are critical. The 'Data quality in emergency care analytics' page explicitly identifies ethnicity data completeness and consistency as a challenge, and frailty data as frequently missing or incomplete. Both pages identify data quality and infrastructure alignment as key constraints for effective analytics.","significance":"Both sources independently identify data quality, specifically ethnicity and frailty data, as significant constraints for analytics, reinforcing the importance of these factors in the NHS context.","pageHashes":["a0f978470c1ad9d3a6b6b2733a454aa5510d09c223419d25928e9aa9feff1503","c927cf4de22448d9ce7ca16569afc49fdeb043078ac1e3fc948f7b5c84090993"],"confirmedAt":"2026-09-04T21:22:33.748Z"}]
---

# Contextual limitations and infrastructure mismatches

AI systems often fail to account for the specific context of individual patients or the operational reality of healthcare settings. A primary reason for poor real-world impact is the mismatch between training environments and deployment infrastructure. Models may be trained on perfectly granular records with high-frequency data, but deployed in systems with fragmented or less detailed records. Without checking for alignment between what the model expects and what it receives, performance degrades significantly.

Context is critical, yet algorithms often fail to account for it. Issues include 'rubbish in, rubbish out' regarding training data, and 'drift' where populations and electronic health records change over time. Algorithms cannot see or infer what is not recorded. Electronic health records do not accurately represent individuals because they miss data (e.g., ethnicity is missing in about 26% of UK records) and fail to codify messy human aspects like feelings, values, and experiences. Furthermore, the most efficacious drug or intervention may not be right for a specific person depending on their context, a nuance algorithms may miss.

## Related

- [[Risk prediction model limitations]]
- [[Data quality in emergency care analytics]]

## Sources

- [HACA2025 - Day 1 - Main Stage - Jess Morley](<https://www.youtube.com/watch?v=Vl58PJKzD40>); SHA-256: `150f164160265a8af7500ce8203f02d1b562e62265af9614e94a12d0fe60e6bc` <!-- synthesis-source:150f164160265a8af7500ce8203f02d1b562e62265af9614e94a12d0fe60e6bc -->
