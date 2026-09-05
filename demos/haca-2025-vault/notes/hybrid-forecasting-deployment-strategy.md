---
title: "Hybrid Forecasting Deployment Strategy"
type: concept
tags: ["model deployment", "hybrid systems", "risk management"]
links: ["Target Deployment Model for NHS Vaccines", "NHS England COVID-19 Vaccine Forecasting System", "Strategy Unit and Conference Funding"]
relationships: [{"target":"Strategy Unit and Conference Funding","type":"analogous","explanation":"The Hybrid Forecasting Deployment Strategy (candidate 0) describes a parallel deployment of a new machine learning model (LightGBM) alongside an existing deterministic system (TDM) to select the 'best value' and mitigate risk. The Strategy Unit and Conference Funding (candidate 0) describes the 2025 Hacker conference relying on external support (Health Foundation, HDR UK) to preserve its non-commercial character and avoid cancellation. Both scenarios involve a new initiative (ML model, conference) operating in parallel to an existing framework (TDM, NHS funding) to maintain stability and core values (robustness, non-commercial status) while managing resource constraints.","significance":"This analogy highlights a common operational pattern in health and care analytics: the use of parallel structures to manage risk and preserve core characteristics when introducing new, resource-intensive initiatives. It suggests that the 'hybrid' approach to forecasting may be a transferable strategy for sustaining non-commercial events.","pageHashes":["5c49ea3292cc6f108c19593beee684f13c130b21e6c6a2eaec3427460a171d5f","03e48efd0970e5f73f3217ec044248dccd8603fa78a6dc0b8bf1fdbe47587cba"],"confirmedAt":"2026-09-04T21:22:34.342Z"}]
---

# Hybrid Forecasting Deployment Strategy

Following the development of the LightGBM forecasting model, NHS England implemented a hybrid deployment strategy rather than fully replacing the existing deterministic Target Deployment Model (TDM). The new machine learning forecast was run in parallel with the deterministic system. The operational framework was designed to select the 'best value' from both the deterministic TDM and the LightGBM forecast for use in live operations. This approach allowed for simultaneous monitoring of both models to ensure robustness and leverage the strengths of each method during deployment phases, such as the autumn/winter 2025 campaign. This strategy mitigates risk by maintaining a fallback to deterministic methods while benefiting from the improved accuracy of machine learning predictions.

## Related

- [[Target Deployment Model for NHS Vaccines]]
- [[NHS England COVID-19 Vaccine Forecasting System]]
- [[Strategy Unit and Conference Funding]]

## Sources

- [HACA2025 - Day 1 - Improving System Flow](<https://www.youtube.com/watch?v=w4vn-QGjE0I>); SHA-256: `c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56` <!-- synthesis-source:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->
