---
title: "Monte Carlo Simulation Methodology for Hospital Demand"
type: concept
tags: ["monte carlo", "simulation", "data science"]
links: ["Demand and capacity modeling for acute care", "Hospital Demand Drivers: Demographic and Non-Demographic"]
---

# Monte Carlo Simulation Methodology for Hospital Demand

The hospital demand model utilises a Monte Carlo simulation approach to generate a distribution of potential demand scenarios. Parameters within the model are assumed to be normally distributed for simplicity. The simulation runs 256 times, sampling parameters differently each time to calculate demand across various hospital activity slices, including inpatients, outpatients, and A&E.
<!-- synthesis-claim:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->

Conceptually, the model operates at the row level, taking a year's worth of individual data rows and applying a multiplicative effect to scale them up or down. This scaling depends on individual characteristics such as age and health conditions, estimating whether there will be more or fewer people with that specific profile in the future. While the theoretical output is row-level, practical implementation aggregates this data to prevent server overload, allowing for the slicing and dicing of results for different analytical views. Hospital activity projections consider three main categories of change: demographic change (e.g., population growth and ageing), non-demographic change (e.g., new medical technologies and improved patient expectations), and mitigating activities or 'left shift' (e.g., reduced smoking rates or better care pathways for frail patients).
<!-- synthesis-claim:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->

## Related

- [[Demand and capacity modeling for acute care]]
- [[Hospital Demand Drivers: Demographic and Non-Demographic]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/Advancing Analytics](<https://www.youtube.com/watch?v=Yj57ivJpKU4>); SHA-256: `e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16` <!-- synthesis-source:e591c9686f34ff737103b33a17139437b0cb9605e387ac577930044d837f4b16 -->
