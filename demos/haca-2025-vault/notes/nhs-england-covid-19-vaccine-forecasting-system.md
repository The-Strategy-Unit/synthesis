---
title: "NHS England COVID-19 Vaccine Forecasting System"
type: synthesis
tags: ["machine learning", "forecasting", "NHS England"]
links: ["Target Deployment Model for NHS Vaccines", "Hybrid Forecasting Deployment Strategy", "LightGBM Optimization and Zero-Inflation Handling", "NHS England Regional Analytics Team"]
relationships: [{"target":"NHS England Regional Analytics Team","type":"mechanistic","explanation":"The NHS England Regional Analytics Team (entity) is the organisational unit responsible for developing and deploying the NHS England COVID-19 Vaccine Forecasting System (synthesis). The forecasting system utilises the LightGBM algorithm and the Darts library to process temporal data, a technical implementation detail that supports the team's mandate to deliver advanced analytics within tight operational deadlines.","significance":"This connection identifies the specific operational team behind a critical logistical system, linking organisational capacity (25-29 posts) with technical capability (LightGBM/Darts) to manage vaccine distribution.","pageHashes":["d66b3fc64c803f44fab64ca77eb802e9de70f2bd13f6ec0d3a46473c44ef20b2","ab16d49f903450b0039c5d54c1538c22e75a4ee17842427a0c049f11b5c6a339"],"confirmedAt":"2026-09-04T21:22:34.278Z"}]
---

# NHS England COVID-19 Vaccine Forecasting System

NHS England developed a machine learning system to forecast COVID-19 vaccine demand across more than 6,000 individual vaccination sites. The system addresses significant logistical challenges, including irregular timelines, seasonal variations between spring and autumn/winter campaigns, and extreme heterogeneity in daily vaccination volumes, which range from a handful to hundreds of doses. To manage this complexity, the forecasting model utilizes LightGBM, a gradient boosting decision tree algorithm chosen for its performance and training speed. Although not a native time series model, LightGBM processes temporal data by translating dates into features such as lags and rolling windows, facilitated by the Darts library for automated feature derivation.

The model is trained globally across all sites, enabling it to transfer learned patterns from data-rich locations to new sites lacking historical data. This approach proved effective during the 2021 spring campaign, where validation against the deterministic Target Deployment Model demonstrated an approximate 20% improvement in accuracy. The forecasting inputs include historical vaccination numbers, current booking data for the next 14 days, implied walk-in rates, site-specific slot capacity, and temporal factors such as the day of the week, bank holidays, and the number of days remaining until the end of the campaign. These features allow the model to capture both static site characteristics and dynamic temporal trends.

## Related

- [[Target Deployment Model for NHS Vaccines]]
- [[Hybrid Forecasting Deployment Strategy]]
- [[LightGBM Optimization and Zero-Inflation Handling]]
- [[NHS England Regional Analytics Team]]

## Sources

- [HACA2025 - Day 1 - Improving System Flow](<https://www.youtube.com/watch?v=w4vn-QGjE0I>); SHA-256: `c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56` <!-- synthesis-source:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->
