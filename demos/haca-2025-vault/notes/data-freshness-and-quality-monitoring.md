---
title: "Data Freshness and Quality Monitoring"
type: concept
tags: ["data quality", "monitoring", "dashboard design"]
links: ["Shropshire UEC Performance Dashboard", "Data quality in emergency care analytics", "Data Infrastructure and Versioning Challenges"]
relationships: [{"target":"Data quality in emergency care analytics","type":"mechanistic","explanation":"The Shropshire UEC dashboard uses a 'RAG' (Red, Amber, Green) rating system to indicate data freshness and integrity, while the emergency care analytics page notes that ethnicity data is frequently subjective and variable, and frailty data is often missing or incomplete. The dashboard's quality page is explicitly designed to track and improve data standards over time, suggesting a direct operational mechanism to address the specific data quality gaps identified in the emergency care analytics context.","significance":"This suggests that the dashboard's quality tracking function is a practical mechanism for operationalising the data quality improvements recommended for emergency care analytics, potentially serving as a model for standardising subjective or missing data fields.","pageHashes":["49137722178b0c820bad042cde3124ee92dc7b6b26dccf8b6e1ae34515b4d845","c927cf4de22448d9ce7ca16569afc49fdeb043078ac1e3fc948f7b5c84090993"],"confirmedAt":"2026-09-04T21:22:34.263Z"},{"target":"Data Infrastructure and Versioning Challenges","type":"shared_constraint","explanation":"The 'Data Freshness and Quality Monitoring' page describes a dashboard using RAG ratings to track data availability and freshness. The 'Data Infrastructure and Versioning Challenges' page discusses managing model versioning over a development period of more than two years, facing challenges in data storage and parameter accumulation. Both pages highlight the critical importance of maintaining data and model integrity over time to support reliable decision-making.","significance":"This underscores a shared constraint in data infrastructure: the need for robust monitoring and versioning strategies to ensure that data and models remain accurate, reproducible, and useful for long-term analysis.","pageHashes":["49137722178b0c820bad042cde3124ee92dc7b6b26dccf8b6e1ae34515b4d845","97bb8fd6c682baa9347902bb763bda5a9b3d5b3674eaf3dad5e311b44f1d157c"],"confirmedAt":"2026-09-04T21:22:34.291Z"}]
---

# Data Freshness and Quality Monitoring

Effective performance dashboards require robust monitoring of data availability and freshness. The Shropshire UEC dashboard employs a 'RAG' (Red, Amber, Green) rating system to indicate the status of metrics. Green dots represent metrics that are up to date, while red dots indicate issues with data flow that require challenge and resolution. Amber or other indicators may show data that is available but slightly out of date. This system allows for operational review to ensure data integrity and timeliness, supporting reliable decision-making. The dashboard also includes a dedicated quality page to track and improve data standards over time.

## Related

- [[Shropshire UEC Performance Dashboard]]
- [[Data quality in emergency care analytics]]
- [[Data Infrastructure and Versioning Challenges]]

## Sources

- [HACA2025 - Day 1 -  Improving System](<https://www.youtube.com/watch?v=5gap_Qv0kTo>); SHA-256: `3e74b9f01ab66754015d2456e824b9565827cc83bceaea6282c800b3e326a93c` <!-- synthesis-source:3e74b9f01ab66754015d2456e824b9565827cc83bceaea6282c800b3e326a93c -->
