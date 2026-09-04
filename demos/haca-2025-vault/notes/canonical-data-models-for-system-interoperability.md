---
title: "Canonical Data Models for System Interoperability"
type: concept
tags: ["data standards", "interoperability", "canonical model"]
links: ["Data Integration Priorities", "Data Repatriation from Central to Local Providers", "Data Validation and Sharing Limitations", "Waste Normalization in Data Teams"]
relationships: [{"target":"Data Validation and Sharing Limitations","type":"mechanistic","explanation":"The 'Canonical Data Models' page describes a standardised data structure to enable data flow and benchmarking, addressing the imbalance where providers send data to central bodies but rarely receive it back. The 'Data Validation and Sharing Limitations' page describes a system-wide intelligence tool (dashboard) that shares unvalidated 'sitrep' data widely to provide granularity and support delivery outputs. The relationship is mechanistic: the canonical model provides the structured, reusable data foundation required to support the scalable, ground-up data infrastructure and wide sharing of validated intelligence described in the second page.","significance":"This suggests that the success of the Shropshire UEC Performance Dashboard and similar 'sitrep' sharing initiatives depends on the prior implementation of a canonical data model to ensure data quality and interoperability. It links the technical standardisation of data entry to the operational capability of real-time intelligence sharing.","pageHashes":["36fae447cc7d13d490cf203ecaeb12e61f045d00e594a3d0ca222af79a5aba68","19d510d3bc482671b6711edbb1244ac3c525cc2d7b5828c48561bdcc2778fc90"],"confirmedAt":"2026-09-04T21:22:34.282Z"},{"target":"Waste Normalization in Data Teams","type":"mechanistic","explanation":"The 'Waste Normalization' page describes a pattern of redundant work where multiple teams process the same data in isolation. The 'Canonical Data Models' page proposes a solution to data fragmentation caused by disparate IT systems. The 'Upfront Data Mapping' page details a step in the Woodyard approach that establishes a single underlying model to feed multiple products. These three concepts are mechanistically linked: the lack of a canonical model (a shared structure) is identified as a root cause of the waste normalization (redundant processing), and the upfront mapping is the specific method proposed to establish that canonical model and prevent the waste.","significance":"This synthesis connects a high-level operational inefficiency (waste normalization) with a specific technical solution (canonical data models) and the planning process required to implement it (upfront mapping). It suggests that addressing data fragmentation is a prerequisite for reducing organizational waste in data teams.","pageHashes":["36fae447cc7d13d490cf203ecaeb12e61f045d00e594a3d0ca222af79a5aba68","21f6858ec0a2c1f5606e6352dfecebc60c88a1532c1b0c6b61f790c8fecaafbc"],"confirmedAt":"2026-09-04T21:22:34.288Z"}]
---

# Canonical Data Models for System Interoperability

The canonical data model is proposed as a solution to data fragmentation caused by disparate IT systems. Issues arise when IT departments and suppliers procure systems without considering how data is organised locally, leading to mismatches, such as wards being labelled 'ABC' in one system versus '123' in another. Adhering to a canonical model ensures that data is recorded in the same structure, facilitating linkage and benchmarking. While not a panacea for all clinical data, it serves as a principle for standardising data entry to enable effective data flow back to providers from central sources. This standardisation is crucial for addressing the imbalance where providers and ICBs send significant amounts of money and data to central bodies but rarely receive it back.

## Related

- [[Data Integration Priorities]]
- [[Data Repatriation from Central to Local Providers]]
- [[Data Validation and Sharing Limitations]]
- [[Waste Normalization in Data Teams]]

## Sources

- [HACA 2025 - Day 1 - Main Stage](<https://www.youtube.com/watch?v=HbXU83_B4nM>); SHA-256: `ec6a528d899f48d3ad76b6dcd1ade9acedad77dd96853a8a05d040fb73784aef` <!-- synthesis-source:ec6a528d899f48d3ad76b6dcd1ade9acedad77dd96853a8a05d040fb73784aef -->
