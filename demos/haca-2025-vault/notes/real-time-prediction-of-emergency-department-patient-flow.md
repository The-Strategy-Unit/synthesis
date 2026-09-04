---
title: "Real-time prediction of emergency department patient flow"
type: concept
tags: ["emergency department", "patient flow", "real-time prediction"]
links: ["Sahlgrenska University Hospital ED prediction project", "Open-source Python package for hospital admission prediction"]
---

# Real-time prediction of emergency department patient flow

Real-time prediction of emergency department (ED) patient flow is a method designed to enhance operational efficiency by forecasting unplanned patient visits and admission needs. This approach provides a data-driven view of pressure on the ED, making abstract problems tangible through numerical metrics. By predicting where patients need to be admitted, hospitals can better manage bed demand and ward capacity, enabling proactive collaboration between the ED and inpatient wards. In the context of Sahlgrenska University Hospital, predicting inpatient inflow was identified as a key objective, as it accounts for roughly 20% of patient visits.
<!-- synthesis-claim:5893a3a5d04acb23986f248cde88d079a1856ebd72852e6daffcd86ced004061 -->

The implementation of such models relies on static data throughout a patient's visit or retained updates to simulate real-time scenarios. A significant challenge involves data quality; at Sahlgrenska, some data points were not saved or deemed irrelevant for future use, making it impossible to utilize certain intended variables. Recreating unfinished visits with completed data proved difficult. Despite having less detailed data and fewer input variables compared to models used at University College London (UCL), Sahlgrenska achieved comparable prediction performance. Feature importance varied between contexts, with age ranking highly in both, but other features differed based on local process differences.
<!-- synthesis-claim:5893a3a5d04acb23986f248cde88d079a1856ebd72852e6daffcd86ced004061 -->

## Related

- [[Sahlgrenska University Hospital ED prediction project]]
- [[Open-source Python package for hospital admission prediction]]

## Sources

- [HACA 2025: Shift to Community: Enhancing patient flow: Real-time prediction at a Swedish emergency..](<https://www.youtube.com/watch?v=1BD5FxppuJ8>); SHA-256: `5893a3a5d04acb23986f248cde88d079a1856ebd72852e6daffcd86ced004061` <!-- synthesis-source:5893a3a5d04acb23986f248cde88d079a1856ebd72852e6daffcd86ced004061 -->
