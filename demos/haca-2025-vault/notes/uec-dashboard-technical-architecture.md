---
title: "UEC Dashboard Technical Architecture"
type: concept
tags: ["data-engineering", "power-bi", "sql-server"]
links: ["UEC Dashboard Operational Use", "Data Validation and Sharing Limitations"]
---

# UEC Dashboard Technical Architecture

The dashboard solution relies on a specific technical stack designed for automated data ingestion and visualization. Providers submit data via a shared space hosted on SharePoint. This data is ingested into a single Excel file using Power Query. A SQL Server Integration Services (SSIS) package automates the process by executing a PowerShell script to refresh the Excel master file and performing extract, transform, and load (ETL) processes into an on-premises SQL Server. The system checks back three months to detect and retrospectively update any changes to the unvalidated data. The data is then structured using a star schema approach within a Power BI solution. Data gateways enable daily automatic refreshes from the Power BI service. The architecture employs a bottom-up approach, loading data at the lowest possible level (daily) to allow roll-ups to weekly, monthly, and quarterly views, and from provider level to an overall system view for comparison.
<!-- synthesis-claim:3e74b9f01ab66754015d2456e824b9565827cc83bceaea6282c800b3e326a93c -->

## Related

- [[UEC Dashboard Operational Use]]
- [[Data Validation and Sharing Limitations]]

## Sources

- [HACA2025 - Day 1 -  Improving System](<https://www.youtube.com/watch?v=5gap_Qv0kTo>); SHA-256: `3e74b9f01ab66754015d2456e824b9565827cc83bceaea6282c800b3e326a93c` <!-- synthesis-source:3e74b9f01ab66754015d2456e824b9565827cc83bceaea6282c800b3e326a93c -->
