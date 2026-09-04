---
title: "Model calibration and explainability in risk prediction"
type: concept
tags: ["calibration", "SHAP", "explainability"]
links: ["XGBoost non-attendance prediction model", "Endoscopy appointment non-attendance intervention", "Risk prediction model limitations"]
relationships: [{"target":"Risk prediction model limitations","type":"mechanistic","explanation":"The page on 'Model calibration and explainability in risk prediction' describes a project where calibration metrics and SHAP values were used to assess and explain a model's predictions for patient non-attendance. The page on 'Risk prediction model limitations' provides a broader critique of such models, noting that they often fail to make a difference in the real world and can introduce new biases. The relationship is mechanistic because the first page details the specific technical methods (calibration, SHAP) used to address the issues and validate the outputs of the systems described in the second page.","significance":"This connection highlights a specific technical response to the systemic limitations of risk prediction models. It suggests that while models may have inherent flaws, specific engineering approaches like calibration and explainability can be employed to mitigate some of these issues and improve their utility and transparency.","pageHashes":["b5af38382d43b21aa0388d7c7e9c70099110bebde1fd482f684256ff0d4ea2bb","537d67ae0dafd482883c2ab3a2dae2da2943ad111aca57d772e41e5244239f36"],"confirmedAt":"2026-09-04T21:22:33.802Z"}]
---

# Model calibration and explainability in risk prediction

Calibration is used as an evaluation metric to assess whether the average assigned risk for a patient group corresponds to their observed non-attendance rate. In this project, patients assigned a low risk (0–2.5%) had an observed non-attendance rate of 1%, while those assigned a high risk (10% or higher) had an observed non-attendance rate of almost 20%. This indicates the model effectively distinguishes between groups with different risk profiles.

SHAP (SHapley Additive exPlanations) is employed to provide transparency in these machine learning risk predictions. It breaks down a risk prediction into individual contributing factors, allowing users to understand why a specific risk assessment was generated. In the context of patient attendance, this helps identify specific barriers or attributes contributing to a high risk score, such as previous non-attendance behavior, rather than just providing a numerical output.

## Related

- [[XGBoost non-attendance prediction model]]
- [[Endoscopy appointment non-attendance intervention]]
- [[Risk prediction model limitations]]

## Sources

- [HACA2025- Day 1- Improving System Flow](<https://www.youtube.com/watch?v=MkYi2psk-Ns>); SHA-256: `dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4` <!-- synthesis-source:dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4 -->
