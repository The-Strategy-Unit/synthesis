---
title: "Data Denominator Limitations in FTP MMR Dashboard"
type: concept
tags: ["ftp", "mmr", "data-quality"]
links: ["CHIS Data Strengths and Limitations for Outbreak Response", "Data Validation and Sharing Limitations"]
relationships: [{"target":"Data Validation and Sharing Limitations","type":"shared_constraint","explanation":"Both pages describe limitations in data infrastructure and sharing practices. The 'Data Denominator Limitations' page notes that derived zero-dose counts are unreliable due to mixing data sources and inconsistencies, while the 'Data Validation and Sharing Limitations' page explicitly states that the data feeding the dashboard is unvalidated and warns of this across the interface. Both highlight that despite these issues, the data is shared widely due to its granularity and utility.","significance":"Identifies a common systemic issue where data quality and validation are compromised for the sake of accessibility and granularity, which is a critical constraint for decision-making in public health and care.","pageHashes":["8d99b66b5f97e215edee902474c29855fe94e1320661e9072893d59dc95340bd","19d510d3bc482671b6711edbb1244ac3c525cc2d7b5828c48561bdcc2778fc90"],"confirmedAt":"2026-09-04T21:22:34.341Z"}]
---

# Data Denominator Limitations in FTP MMR Dashboard

The FTP MMR dashboard provides data on the number of children aged 4 to 17 who received one dose of the MMR vaccine by Lower Layer Super Output Area (LSOA). However, this data source lacks information on the number of children who received zero doses and does not provide the total number of eligible children by LSOA. Consequently, knowing the count of one-dose recipients is insufficient for determining unvaccinated populations without a denominator.

Attempts to derive zero-dose counts by subtracting one-dose recipients from Office for National Statistics (ONS) population estimates resulted in negative numbers in some areas, indicating that the one-dose counts exceeded the estimated population. This discrepancy arises from mixing data sources, using outdated estimates, and other inconsistencies, which undermines the reliability of the derived denominators and percentages. Despite these limitations, the data is generally found to be useful, particularly when regional teams supplement national-level data, though the process for obtaining reports can be lengthy.

## Related

- [[CHIS Data Strengths and Limitations for Outbreak Response]]
- [[Data Validation and Sharing Limitations]]

## Sources

- [HACA 2025 - Day 1- Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=1gAsm5VmgXk>); SHA-256: `a7db957f5ef338a76334c8b7f841b3e2c4be7fecbc3a6a09fe2a83632ef1d15d` <!-- synthesis-source:a7db957f5ef338a76334c8b7f841b3e2c4be7fecbc3a6a09fe2a83632ef1d15d -->
