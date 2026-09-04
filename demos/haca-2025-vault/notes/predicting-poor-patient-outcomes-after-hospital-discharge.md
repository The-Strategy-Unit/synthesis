---
title: "Predicting poor patient outcomes after hospital discharge"
type: synthesis
tags: ["healthcare-analytics", "patient-outcomes", "discharge-delays"]
links: ["Definition of poor patient outcome 90 days post-discharge", "Data quality of client-level adult social care datasets"]
---

# Predicting poor patient outcomes after hospital discharge

A study by James Edholm and Ewan Evans from the Department of Health and Social Care analysed characteristics associated with poor patient outcomes within 90 days of hospital discharge. The research utilised a logistic regression model trained on data from January 2023 to March 2025, focusing specifically on discharges occurring in 2024. The model achieved 64% accuracy in predicting outcomes. Key datasets included de-duplicated extracts of adult social care users, cleaned Hospital Episode Statistics (HES) derived from the Secondary Uses Service (SUS), and Office for National Statistics (ONS) death data.
<!-- synthesis-claim:0c7835363a8afacfd41616ecd8692220a5164b2dfdff549c2c896fcf71b064ef -->

The analysis identified pre-admission other care, pre-admission care home status, and patient age as the strongest determinants of discharge outcome. Frailty was operationalised using the Gilbert et al methodology, which assigns a score to every primary diagnosis code. Since patients can have multiple diagnosis codes per hospital spell, individual scores are summed at the discharge level to create a composite frailty score, which was included as a feature in the model.
<!-- synthesis-claim:0c7835363a8afacfd41616ecd8692220a5164b2dfdff549c2c896fcf71b064ef -->

The study estimated that hospital discharge delays are associated with an additional 1,200 deaths per year among patients over 65 in England. This figure was derived by comparing the predicted likelihood of a poor outcome for a mean patient (aged approximately 72) with an observed average discharge delay of 1.32 days versus a zero-day delay. The model indicated a 0.2 percentage point reduction in the likelihood of a poor outcome when moving from 1.32 days to zero days. Applying this change to approximately 2.3 million discharges of over-65s in 2024 yielded the estimated attribution of 1,200 deaths, 3,300 additional readmissions, and 300 additional new long-term residential services.
<!-- synthesis-claim:0c7835363a8afacfd41616ecd8692220a5164b2dfdff549c2c896fcf71b064ef -->

## Related

- [[Definition of poor patient outcome 90 days post-discharge]]
- [[Data quality of client-level adult social care datasets]]

## Sources

- [HACA 2025: Shift to Community: Modelling characteristics associated with the risk of a poor...](<https://www.youtube.com/watch?v=sRWm70gTLuU>); SHA-256: `0c7835363a8afacfd41616ecd8692220a5164b2dfdff549c2c896fcf71b064ef` <!-- synthesis-source:0c7835363a8afacfd41616ecd8692220a5164b2dfdff549c2c896fcf71b064ef -->
