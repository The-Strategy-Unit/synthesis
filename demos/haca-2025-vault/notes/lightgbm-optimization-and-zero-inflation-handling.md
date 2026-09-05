---
title: "LightGBM Optimization and Zero-Inflation Handling"
type: concept
tags: ["lightgbm", "loss-functions", "zero-inflation"]
links: ["NHS England COVID-19 Vaccine Forecasting System"]
---

# LightGBM Optimization and Zero-Inflation Handling

The development of the NHS vaccine forecasting model involved specific methodological adjustments to improve accuracy and robustness. An evaluation of loss functions in LightGBM training identified that the default Mean Squared Error (MSE) objective was susceptible to outliers due to the squaring of errors. Switching to Mean Absolute Error (MAE) was investigated and adopted to improve forecast robustness. Additionally, the model addressed the challenge of zero-inflated data, where many vaccination sites have no activity on certain days. Standard regressors often struggle with this by predicting small non-zero numbers instead of zero. The solution involved a combined classification and regression setup: first classifying whether an event will occur (zero vs. non-zero), and then applying regression to predict the magnitude for non-zero cases. This approach, combined with Lasso regularization, contributed to the reported 20% improvement in forecast accuracy.
<!-- synthesis-claim:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->

## Related

- [[NHS England COVID-19 Vaccine Forecasting System]]

## Sources

- [HACA2025 - Day 1 - Improving System Flow](<https://www.youtube.com/watch?v=w4vn-QGjE0I>); SHA-256: `c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56` <!-- synthesis-source:c2fc6deca39f4b466dbd18d3fe6888281756ba5be01daa2a97732d1b2b71ce56 -->
