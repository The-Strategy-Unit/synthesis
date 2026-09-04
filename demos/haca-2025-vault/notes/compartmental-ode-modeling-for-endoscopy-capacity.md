---
title: "Compartmental ODE modeling for endoscopy capacity"
type: concept
tags: ["mathematical modeling", "healthcare logistics", "ordinary differential equations"]
links: ["Endoscopy capacity mismatch scenarios", "NHS endoscopy service challenges post-pandemic", "Real-time prediction of emergency department patient flow", "Endoscopy appointment non-attendance intervention"]
relationships: [{"target":"Real-time prediction of emergency department patient flow","type":"analogous","explanation":"The 'Compartmental ODE modeling for endoscopy capacity' page describes a framework that abstracts the patient journey into interconnected compartments (e.g., referrals, waiting lists, admission) to simulate system flow and capacity mismatches. The 'Real-time prediction of emergency department patient flow' page describes a method that forecasts patient inflow to manage bed demand. Both approaches abstract complex, dynamic patient flows into numerical models to identify bottlenecks and optimise resource allocation, representing analogous applications of mathematical modelling to healthcare operational challenges.","significance":"This analogy suggests that the compartmental modelling techniques developed for endoscopy capacity could be adapted or applied to other high-volume, time-sensitive clinical pathways, such as emergency department flow, to improve predictive accuracy and operational planning.","pageHashes":["0457bfb08cc6c66fbede1bfd85901ab9bc50a6bd074e85c03e885032df073eda","815966a5ad9eeac394f8fde59775cebffc6068f4edf9af3b5507901a6eaf823f"],"confirmedAt":"2026-09-04T21:22:33.977Z"},{"target":"Endoscopy appointment non-attendance intervention","type":"mechanistic","explanation":"The 'Compartmental ODE modeling' page describes a mathematical framework that simulates patient flow through compartments (referrals, waiting lists, admission) to manage capacity mismatches. The 'Endoscopy appointment non-attendance intervention' page describes a workflow where a machine learning model outputs a risk score to flag patients for proactive contact, aiming to reduce non-attendance.","significance":"Both pages describe specific, evidence-based interventions for endoscopy services: one uses a mathematical model to optimise resource allocation, and the other uses a data-driven workflow to improve patient attendance.","pageHashes":["0457bfb08cc6c66fbede1bfd85901ab9bc50a6bd074e85c03e885032df073eda","57f742f344ea4fd05830d58703462a20242d5a183dbb296a80ee92021c58e769"],"confirmedAt":"2026-09-04T21:22:34.019Z"}]
---

# Compartmental ODE modeling for endoscopy capacity

A mathematical framework using compartmental ordinary differential equations (ODEs) has been developed to address short-term, weekly resource planning for gastrointestinal endoscopy services. This approach contrasts with the medium-term Excel-based models typically used by the NHS, offering a method to simulate real-time fluctuations and optimize resource allocation. The model tracks state variables at fine time resolutions, enabling the simulation of 'what-if' scenarios regarding capacity and referral patterns. Its primary aim is to manage capacity mismatches, such as the over-provision of upper GI services versus the under-provision of lower GI services.

The framework abstracts the patient journey into 18 interconnected compartments, analogous to SIR models used in infectious disease tracking. These compartments include referrals, active and planned waiting lists, admission, in-procedure status, and discharge. The model incorporates seasonality and stochastic variables to represent periodic and unpredictable fluctuations in referrals. A carrying capacity constraint is applied to admission rates to reflect limitations in theater rooms, personnel, and equipment, capping the flow from waiting lists to active procedures when maximum capacity is reached.

The structural basis for the model is derived from clinical meetings and operational data, distinguishing between upper GI (OGD) and lower GI (colonoscopy) procedures. Referrals enter via three main pathways: routine (six-week referral), urgent suspected cancer (USC), and planned (surveillance). Patients from routine and USC pathways move to active waiting lists, while planned referrals move to planned waiting lists. The model focuses specifically on OGD and colonoscopy, excluding other procedures such as ERCP and sigmoidoscopy.

## Related

- [[Endoscopy capacity mismatch scenarios]]
- [[NHS endoscopy service challenges post-pandemic]]
- [[Real-time prediction of emergency department patient flow]]
- [[Endoscopy appointment non-attendance intervention]]

## Sources

- [HACA2025 - Day 2 - Improving System Flow](<https://www.youtube.com/watch?v=7DXUaFhDFwU>); SHA-256: `5f8a9f3001c62fc9f77b34cbb0c04528e28f8cfec304bc928b00befef68d8a6a` <!-- synthesis-source:5f8a9f3001c62fc9f77b34cbb0c04528e28f8cfec304bc928b00befef68d8a6a -->
