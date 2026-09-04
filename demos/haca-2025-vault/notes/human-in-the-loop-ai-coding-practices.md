---
title: "Human-in-the-Loop AI Coding Practices"
type: concept
tags: ["ai coding", "human oversight", "software development"]
links: ["Python Data Pipeline for Pharmacy Data", "AI-Assisted Transition from Excel to Python", "Performance and refinement of AI screening"]
relationships: [{"target":"Performance and refinement of AI screening","type":"mechanistic","explanation":"The 'Human-in-the-Loop AI Coding Practices' page describes a method where human domain knowledge is injected into prompts to guide AI output, specifically mentioning the GPhC dataset. The 'Performance and refinement of AI screening' page details a similar process where prompt refinements (adding explicit keywords like 'outpatient' and 'community healthcare') were used to correct AI exclusions and improve accuracy. Both pages describe the iterative refinement of AI prompts using specific domain knowledge to improve performance.","significance":"This suggests a common, evidence-backed mechanism for improving AI outputs in healthcare contexts: the use of iterative prompt engineering that incorporates specific domain terminology and constraints to reduce errors and improve relevance.","pageHashes":["1c598f4b53df0e4df184041fe60103d7e5c6f32f766c4e6d59143c222bc627aa","5751f6fbf1f5fa9668043d84af1486448b6f2b6ee1b7db3f0d445a3ec7f3cbfe"],"confirmedAt":"2026-09-04T21:22:34.270Z"}]
---

# Human-in-the-Loop AI Coding Practices

A cautionary perspective on using AI-powered coding tools, such as Cursor, for data science tasks. The speed of AI development can be overwhelming, necessitating a clear distinction between tasks humans can perform versus those AI can perform. The approach advocates for maintaining human oversight in the loop, particularly when integrating AI-generated code into structured data pipelines and ensuring data integrity.

'Human-in-the-loop' is defined not merely as simple validation, such as thumbs-up or down feedback, but as an extended process where human domain knowledge is injected into prompts to improve AI output. By providing specific context—such as focusing on the UK profession or the GPhC dataset—rather than generic data tables, the AI generates more accurate and relevant answers. This leverages human expertise to guide the model, ensuring that the generated code and analysis align with specific professional standards and scope.

## Related

- [[Python Data Pipeline for Pharmacy Data]]
- [[AI-Assisted Transition from Excel to Python]]
- [[Performance and refinement of AI screening]]

## Sources

- [HACA 2025: Shift to Community: Design a model for community pharmacy workforce with open source data](<https://www.youtube.com/watch?v=t5KkMfe4TdA>); SHA-256: `745847cc6c3f79e0a10b45acead91a1380e28da9e4f6fa61470a8171e806bc68` <!-- synthesis-source:745847cc6c3f79e0a10b45acead91a1380e28da9e4f6fa61470a8171e806bc68 -->
