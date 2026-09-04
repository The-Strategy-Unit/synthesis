---
title: "Vaccination Forecasting Bias and Environmental Drift"
type: concept
tags: ["bias", "data-drift", "model-monitoring"]
links: ["Hybrid Forecasting Deployment Strategy", "NHS England COVID-19 Vaccine Forecasting System"]
---

# Vaccination Forecasting Bias and Environmental Drift

Analysis of forecasting bias in vaccination campaigns reveals that predictive models can fail if the underlying operating environment changes. Bias above zero indicates over-forecasting, while bias below zero indicates under-forecasting. In a specific autumn/winter campaign, the model exhibited over-forecasting bias. This deviation was attributed to external changes, specifically a shift in COVID vaccination eligibility criteria from over 65 to over 75 years old. This change led to a smaller eligible population, more active vaccination sites, and a higher cancellation rate at the start of the campaign, which disrupted the predictive power of key features like booking signals. These findings highlight the importance of continuous monitoring of model performance throughout its lifecycle and considering 'drill deployment' when environmental factors differ from previous campaigns. Integrating data quality metrics directly into the model is also recommended to detect anomalies or shifts in data patterns.
<!-- synthesis-claim:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->

## Related

- [[Hybrid Forecasting Deployment Strategy]]
- [[NHS England COVID-19 Vaccine Forecasting System]]

## Sources

- [HACA2025 - Day 1 - Improving System Flow](<https://www.youtube.com/watch?v=w4vn-QGjE0I>); SHA-256: `c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56` <!-- synthesis-source:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->
