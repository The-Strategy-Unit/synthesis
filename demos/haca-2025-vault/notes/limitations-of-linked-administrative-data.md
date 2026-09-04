---
title: "Limitations of linked administrative data"
type: concept
tags: ["data quality", "methodological limitations", "research constraints"]
links: ["Linked NHS data analysis for suicide prevention", "Comparison with coroner's report audits", "Rag Reporting Limitations", "Technical stack for healthcare data analysis"]
relationships: [{"target":"Rag Reporting Limitations","type":"contradicts","explanation":"The 'Limitations of linked administrative data' page describes the use of ambulance calls for cardiac arrest to predict the date of death as a partial resolution to the absence of a specific date of death. The 'Rag Reporting Limitations' page describes how RAG reports can lead to 'flip-flopping' and 'sputtling' due to natural variation, and how SPC charts reveal that what appears as a problem in RAG reports may simply be random variation. The pages contradict in their assessment of the utility of such predictive or summary methods: one suggests they can provide useful insights (predicting death dates), while the other argues they can lead to inappropriate reactions and misinterpretation of data.","significance":"This contradiction highlights the ongoing debate about the appropriate use of predictive metrics and summary reporting in healthcare, warning against the potential for such methods to create more confusion than clarity if not understood by stakeholders.","pageHashes":["974f82463bb8030e2412c96de790b9612993d247bc1e5d5f89e84374e92717f1","50d1ecffa84f9a340b49cb42bfe5d3aa8479acda239fdb82a7ffe89289994baa"],"confirmedAt":"2026-09-04T21:22:34.361Z"},{"target":"Technical stack for healthcare data analysis","type":"shared_constraint","explanation":"The 'Limitations of linked administrative data' page lists data quality and technical linkage issues as primary challenges. The 'Technical stack for healthcare data analysis' page describes a stack utilising SQL and R, with code held in Snowflake databases and made available on GitHub. The shared constraint is the reliance on a specific technical infrastructure (Snowflake, GitHub, SQL) to manage and analyse the data, which is subject to the same technical hurdles (linkage quality, platform access) mentioned in the limitations page.","significance":"It identifies a common technical dependency between the two pages, noting that the utility of the analysis is constrained by the capabilities and limitations of the chosen technical stack.","pageHashes":["974f82463bb8030e2412c96de790b9612993d247bc1e5d5f89e84374e92717f1","e3b1eff68cc45bb744f0cc3f9301a49af3f0165614379a004871027b18f52468"],"confirmedAt":"2026-09-04T21:22:34.394Z"}]
---

# Limitations of linked administrative data

Challenges encountered when using linked NHS datasets for suicide prevention research include data quality and technical linkage issues. A primary limitation is the absence of a specific date of death in the dataset; the available death register data provided only the year and month of death. This granularity limitation complicates the identification of true prevention opportunities, as it is difficult to filter out events that immediately precede death but are not actionable intervention points, such as ambulance calls for cardiac arrest.

A partial resolution involves using ambulance calls for cardiac arrest to predict the date of death, but this remains a constraint on the utility and precision of the generated graphs and insights. The lack of precise timing affects the ability to distinguish between proximate causes and earlier, potentially preventable, health system interactions. Additionally, technical hurdles arose regarding linkage quality and platform access, including records failing to link and discrepancies in data extraction results when running identical SQL code on a remote desktop platform, attributed to account access settings.

## Related

- [[Linked NHS data analysis for suicide prevention]]
- [[Comparison with coroner's report audits]]
- [[Rag Reporting Limitations]]
- [[Technical stack for healthcare data analysis]]

## Sources

- [HACA 2025 - Day 1- Targeting care / Advancing analytics](<https://www.youtube.com/watch?v=sxj_NksWkMI>); SHA-256: `05aff1d0d937c3c93eed54ff27695cab9b0e902df71b2f0af583fd64f440d873` <!-- synthesis-source:05aff1d0d937c3c93eed54ff27695cab9b0e902df71b2f0af583fd64f440d873 -->
