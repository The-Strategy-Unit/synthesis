---
title: "Endoscopy appointment non-attendance intervention"
type: synthesis
tags: ["health navigation", "patient engagement", "machine learning implementation"]
links: ["Model calibration and explainability in risk prediction", "Impact of proactive calling on high-risk patient attendance", "Information governance in qualitative data collection", "Virtual Fracture Clinic Operational Efficiency and Attendance"]
relationships: [{"target":"Virtual Fracture Clinic Operational Efficiency and Attendance","type":"causal_hypothesis","explanation":"The 'Endoscopy appointment non-attendance intervention' page reports a 79% contact rate and 88% helpfulness survey response for proactive check-in calls. The 'Virtual Fracture Clinic Operational Efficiency and Attendance' page reports a significant reduction in Did Not Attend (DNA) rates (e.g., from 23.5% to 8.3% for new patients) and attributes these improvements to 'patients receiving clear communication and appropriate appointments'. The intervention's use of a local phone number and proactive contact to identify barriers suggests a causal link between proactive communication and reduced DNA rates, though the specific mechanism (e.g., appointment suitability vs. reminder) is not explicitly detailed in the sources.","significance":"This hypothesis suggests that proactive, data-driven communication strategies, such as those used in the endoscopy intervention, are a viable mechanism for reducing non-attendance in other outpatient settings, such as fracture clinics. It supports the broader goal of improving system flow and reducing costs associated with DNA appointments.","pageHashes":["57f742f344ea4fd05830d58703462a20242d5a183dbb296a80ee92021c58e769","23f6f797693261be1e264a544dcdacee2affd7b1dd8764f37ea0221adf73e07b"],"confirmedAt":"2026-09-04T21:22:34.134Z"}]
---

# Endoscopy appointment non-attendance intervention

The project implemented a workflow where the machine learning model outputs a risk score between 1% and 100%, flagging patients with a risk above 10% for proactive contact. The process involves extracting data from on-premises servers, processing it through a cloud-based machine learning endpoint, and displaying results in a PowerBI dashboard. Health navigators use this dashboard to identify high-risk patients and make check-in phone calls.

The intervention ran from October 10, 2024, to January 22, 2025, involving 865 outbound calls for 609 distinct appointments across 515 unique patients. The contact rate was 79%, with calls averaging 3–5 minutes. A feedback survey indicated 88% of respondents found the calls helpful. Using a local, recognizable phone number was critical for maintaining high contact rates, as generic numbers resulted in a 30 percentage point lower contact rate in previous attempts. Callers also collected qualitative data on barriers to attendance; this data was not stored long-term or associated with patients in the permanent record, avoiding significant Information Governance hurdles.

## Related

- [[Model calibration and explainability in risk prediction]]
- [[Impact of proactive calling on high-risk patient attendance]]
- [[Information governance in qualitative data collection]]
- [[Virtual Fracture Clinic Operational Efficiency and Attendance]]

## Sources

- [HACA2025- Day 1- Improving System Flow](<https://www.youtube.com/watch?v=MkYi2psk-Ns>); SHA-256: `dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4` <!-- synthesis-source:dbfbb160ff1b9a8e189e3eb3b641d68efa8cde879c995184d3ecea2708777fc4 -->
