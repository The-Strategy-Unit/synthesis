---
title: "Limitations of Brent Social Care Transition Model"
type: concept
tags: ["modeling limitations", "future research", "data quality"]
links: ["Brent Adult Social Care Multi-State Transition Model", "Social Care Transition Probabilities and Demographics", "Unstructured data analysis in social care"]
relationships: [{"target":"Unstructured data analysis in social care","type":"mechanistic","explanation":"The 'Limitations of Brent Social Care Transition Model' page identifies that the Markov model assumes constant transition probabilities, which is problematic given the data covers the COVID-19 pandemic period. The 'Unstructured data analysis in social care' page proposes using large language models and natural language processing to ingest and explore unstructured data sources, such as case notes and inspection reports. This approach aims to build a richer, more nuanced picture of adult social care beyond structured metrics, potentially addressing the limitations of simplified, constant-probability models by incorporating granular, non-tabular information.","significance":"This suggests a potential methodological improvement for social care modelling: moving from simplified, constant-probability Markov models to more nuanced, data-rich approaches that can capture the complexity of care journeys, particularly during periods of significant disruption like the pandemic.","pageHashes":["4481f811b68d8807804b8b967970d6c97c3cb03ffd122ad60954d1135ec498bd","406e383bf6213f41efb06010eddd76f07287ba7818a891cfa86ebdda1a3083aa"],"confirmedAt":"2026-09-04T21:22:34.261Z"}]
---

# Limitations of Brent Social Care Transition Model

The Markov model used for Brent local authority data has several significant limitations. Transition probabilities are assumed to be constant over time, which is problematic given the data covers the COVID pandemic period, characterised by unusual spikes in deaths and care requests. The model simplifies heterogeneous data, lumping together diverse 'care at home' packages ranging from one hour a week to warden-controlled housing. It only captures end-of-year transitions, ignoring within-year changes, and relies on a five-year follow-up period. Additionally, the 'not receiving care' category is highly heterogeneous, including self-funders, those with informal care, and those needing no care, but lacks data to distinguish these groups.

Regarding duration, people from Black ethnic groups showed a slightly longer stay in adult social care, though these differences were not statistically significant. The analysis aims to probe these potential inequalities further. Current demographic factors were not found to be associated with transitions into more intensive care, such as moving from care at home to residential care. Future modelling efforts aim to incorporate health conditions and trajectories using linked NHS data, as well as new indices of multiple deprivation. There is interest in distinguishing between residential and nursing care, although sample sizes may be small. Expanding the analysis beyond Brent to North West London is proposed to increase sample size, despite challenges with inconsistent data structures across boroughs. Alternative modelling approaches, such as neural networks, have been suggested but remain untested. Collaboration with universities is identified as necessary due to limited statistical resources within the local authority.

## Related

- [[Brent Adult Social Care Multi-State Transition Model]]
- [[Social Care Transition Probabilities and Demographics]]
- [[Unstructured data analysis in social care]]

## Sources

- [HACA2025 - Day 2 - Improving System Flow](<https://www.youtube.com/watch?v=Q8JKhMcNj98>); SHA-256: `c9cef846d25d9e678eac83035bbd9d3f1a365a538945efc70b8839edab1e8d1a` <!-- synthesis-source:c9cef846d25d9e678eac83035bbd9d3f1a365a538945efc70b8839edab1e8d1a -->
