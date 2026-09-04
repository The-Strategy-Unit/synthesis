---
title: "XGBoost non-attendance prediction model"
type: concept
tags: ["machine learning", "xgboost", "prediction"]
links: ["Northumbria Healthcare endoscopy non-attendance prediction project", "Endoscopy non-attendance risk factors"]
---

# XGBoost non-attendance prediction model

A supervised machine learning model was developed to estimate the probability of a patient not attending an endoscopy appointment, referred to as the DNA risk score. The model was trained on approximately 39,000 endoscopy appointments from 2022 to 2024. After testing various models and parameter settings, XGBoost was selected over conventional regression models (logistic and polynomial) due to a significant jump in predictive accuracy, despite the trade-off between maximizing performance and maintaining interpretability.
<!-- synthesis-claim:dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4 -->

Data was sourced primarily from the Patient Administration System (PAS), including spell and episode levels, referral details, and demographics such as IMD scores, nursing home status, prisoner status, and distance to hospital. Data from other systems like Icarus and Epic were explored but did not significantly add to predictive power and were excluded from the final model. The model uses historical data split into training and testing sets to ensure unbiased performance estimation. To mitigate concerns about complexity, the model was evaluated across multiple metrics and different patient subcohorts.
<!-- synthesis-claim:dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4 -->

## Related

- [[Northumbria Healthcare endoscopy non-attendance prediction project]]
- [[Endoscopy non-attendance risk factors]]

## Sources

- [HACA2025- Day 1- Improving System Flow](<https://www.youtube.com/watch?v=MkYi2psk-Ns>); SHA-256: `dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4` <!-- synthesis-source:dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4 -->
