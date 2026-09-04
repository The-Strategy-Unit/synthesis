---
title: "NHS Lothian MAT reporting tools"
type: entity
tags: ["software tools", "R programming", "REDCap"]
links: ["Semi-automated MAT reporting workflow", "Python Data Pipeline for Pharmacy Data", "NHSBSA Open API Data Retrieval"]
relationships: [{"target":"Python Data Pipeline for Pharmacy Data","type":"analogous","explanation":"The 'NHS Lothian MAT reporting tools' page describes a semi-automated data pipeline using REDCap, R, and Flexdashboard to replace manual spreadsheet handling. The 'Python Data Pipeline for Pharmacy Data' page describes a methodology for constructing data pipelines in Python to replace or augment Excel-based workforce modeling, using GitHub and API queries. Both projects involve a transition from manual, spreadsheet-based processes to automated, code-based data pipelines to improve data traceability, scalability, and reduce manual handling.","significance":"This analogy highlights a common trend in NHS data engineering where teams are moving away from reliance on Excel and manual file transfers towards more robust, automated, and scalable data pipelines, often leveraging scripting languages like R or Python.","pageHashes":["6d22463e480c5974120add91b1d9c59272c347aed118610727e2f938e4083dea","861035130246a901a66bba177b1c0e8bdaf2fc7ffe03691d1c329698f85913b1"],"confirmedAt":"2026-09-04T21:22:34.086Z"},{"target":"NHSBSA Open API Data Retrieval","type":"mechanistic","explanation":"The NHS Lothian MAT reporting tools page describes a specific software stack (REDCap, `redcapR`, `tidyverse`, Posit Connect, Flexdashboard) used to automate data extraction, transformation, and visualization. The NHSBSA Open API Data Retrieval page describes a process for accessing NHS data via an open API platform to retrieve specific variables for dynamic analysis. While both describe data retrieval and analysis pipelines, the NHS Lothian tools focus on a secure, internal, automated workflow for a specific clinical indicator (MAT), whereas the NHSBSA API describes a general method for accessing public data resources programmatically. The mechanisms differ: one uses a secure API bridge within R for internal data, the other uses an open API to browse and retrieve external data.","significance":"This highlights the diversity of data access mechanisms within the NHS: secure, internal, automated pipelines for clinical reporting versus open, public APIs for external data retrieval. Understanding these distinct mechanisms is crucial for data engineers and analysts selecting appropriate tools for specific tasks.","pageHashes":["6d22463e480c5974120add91b1d9c59272c347aed118610727e2f938e4083dea","3eb2b3971c8ee2e68d75409802b7bb37f4de6c2a05a05c88feed23b4197c0a58"],"confirmedAt":"2026-09-04T21:22:34.250Z"}]
---

# NHS Lothian MAT reporting tools

The specific software stack utilized by NHS Lothian data analysts to automate Medication Assisted Treatment (MAT) reporting includes several integrated components. REDCap serves as the secure platform for service staff to enter standardized data. The `redcapR` package in R establishes a secure API bridge for data extraction, allowing R scripts to automatically pull the latest data from REDCap without manual file downloads. This integration ensures that data imports are stable and traceable.

Once extracted, the `tidyverse` and `lubridate` packages in R handle data transformation and cleaning. Since raw data exported from REDCap is often messy, the R script automatically standardizes the structure, keeping only the fields necessary for MAT indicators. Posit Connect executes this R code on a weekly schedule without manual intervention. Finally, Flexdashboard combined with Plotly creates interactive, web-based visualizations. This toolset enables a transition from emailed spreadsheets to a unified, auditable pipeline that reduces manual handling of sensitive information and improves data traceability.

## Related

- [[Semi-automated MAT reporting workflow]]
- [[Python Data Pipeline for Pharmacy Data]]
- [[NHSBSA Open API Data Retrieval]]

## Sources

- [HACA2025 - Day 1- Improving System Flow](<https://www.youtube.com/watch?v=xlx0kAw62Jo>); SHA-256: `522f92c51507a75fac0864487c96e46ca17eec831e993f6c011925f70f6cebf3` <!-- synthesis-source:522f92c51507a75fac0864487c96e46ca17eec831e993f6c011925f70f6cebf3 -->
