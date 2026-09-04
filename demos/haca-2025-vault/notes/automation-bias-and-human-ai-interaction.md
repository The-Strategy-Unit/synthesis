---
title: "Automation bias and human-AI interaction"
type: concept
tags: ["automation bias", "human-computer interaction", "explainable AI"]
links: ["Contextual limitations and infrastructure mismatches", "Human-in-the-Loop AI Coding Practices", "Limitations of business intelligence in complex healthcare"]
relationships: [{"target":"Human-in-the-Loop AI Coding Practices","type":"analogous","explanation":"Both pages describe the necessity of maintaining human oversight and active interpretation when using AI systems. Page 710 emphasises 'automation bias' and the need to interpret outputs rather than passively accept them, while Page 819 advocates for 'human-in-the-loop' coding practices where human domain knowledge is injected into prompts to guide the AI.","significance":"This relationship highlights a shared cautionary principle applicable across different domains: the risk of over-reliance on AI outputs and the critical role of human expertise in validating and guiding AI performance.","pageHashes":["e0dc3c8e7348ab1a3b4f708b64bd666f88c0adaa2c002ffec4db97f7f54c2481","1c598f4b53df0e4df184041fe60103d7e5c6f32f766c4e6d59143c222bc627aa"],"confirmedAt":"2026-09-04T21:22:34.023Z"},{"target":"Limitations of business intelligence in complex healthcare","type":"mechanistic","explanation":"The page on Automation bias describes a specific cognitive risk where users passively accept algorithmic outputs, assuming the computer 'always knows best.' The page on Limitations of business intelligence identifies a structural cause for this risk: the reliance on BI tools (dashboards, summary statistics) crowds out deeper analysis and strategic insight. The text suggests that when BI provides only rapid, superficial data, users are left with limited information to challenge or interpret outputs, thereby increasing the likelihood of automation bias.","significance":"This connection highlights a potential systemic vulnerability in NHS data systems. If BI tools are used to manage complex care decisions without providing the strategic context needed for human oversight, they may inadvertently foster automation bias, where clinicians or managers defer to the system's outputs rather than exercising independent judgment.","pageHashes":["e0dc3c8e7348ab1a3b4f708b64bd666f88c0adaa2c002ffec4db97f7f54c2481","faad8ca87e2001e03a308dd00da4a9f9cb56287dbb726a51a138df4cf835cefa"],"confirmedAt":"2026-09-04T21:22:34.079Z"}]
---

# Automation bias and human-AI interaction

Automation bias is the tendency for users to trust algorithmic decisions over their own judgment, assuming the computer always knows best. In healthcare, this is a significant risk because AI systems are deployed within complex human-computer interaction frameworks rather than as standalone entities. Clinicians must remain in control of decision-making processes and actively interpret algorithmic outputs rather than accepting them passively.

This requires awareness that AI lacks contextual understanding of individual patient circumstances and that the 'best' evidence-based intervention may not be appropriate for a specific person depending on their context. There is a distinction between explainability (XAI) and interpretability. XAI tools, such as Shapley values, act like 'tracing paper' to show which inputs influenced an output, but this is not a true explanation. Large language models often engage in 'performative reasoning,' providing explanations that mimic human interaction patterns without reflecting the actual internal processes. Focus should shift to interpretability, which seeks to understand the exact processes under the hood, such as data sourcing and matching, to prevent users from feeling subordinate to model outputs.

## Related

- [[Contextual limitations and infrastructure mismatches]]
- [[Human-in-the-Loop AI Coding Practices]]
- [[Limitations of business intelligence in complex healthcare]]

## Sources

- [HACA2025 - Day 1 - Main Stage - Jess Morley](<https://www.youtube.com/watch?v=Vl58PJKzD40>); SHA-256: `150f164160265a8af7500ce8203f02d1b562e62265af9614e94a12d0fe60e6bc` <!-- synthesis-source:150f164160265a8af7500ce8203f02d1b562e62265af9614e94a12d0fe60e6bc -->
