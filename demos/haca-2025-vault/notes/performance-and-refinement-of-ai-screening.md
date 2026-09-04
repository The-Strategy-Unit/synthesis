---
title: "Performance and refinement of AI screening"
type: concept
tags: ["performance-metrics", "prompt-engineering", "validation"]
links: ["AI-assisted evidence screening methodology"]
---

# Performance and refinement of AI screening

The performance of the AI screening model varied depending on the complexity of the criteria at each stage. In earlier stages involving simple criteria such as language, publication date, UK basis, and general healthcare focus, accuracy exceeded 93%. However, in later stages involving complex criteria like specific outcomes, major shifts, and cost-saving focus, accuracy ranged from 78% to 84%.
<!-- synthesis-claim:62e25e9809382f62b0eff024fa7ff130ffbc06c437c45f9f61ae9393812f5241 -->

Initial performance in Stage Three revealed a high number of exclusions by the AI that were included by manual reviewers. Analysis indicated that the AI missed implicit mentions of community healthcare, such as 'GP' or 'home care', because the prompts lacked explicit signals for these terms. Prompt refinements were made to explicitly include keywords like 'outpatient', 'community healthcare', 'home care', and 'home'. This refinement significantly reduced false exclusions, with the AI excluding only five papers post-tweak, and improved overall accuracy from 64% to 88% and precision from 60% to 87%.
<!-- synthesis-claim:62e25e9809382f62b0eff024fa7ff130ffbc06c437c45f9f61ae9393812f5241 -->

The project successfully screened 5,175 papers down to 186 that met the final criteria for cost-saving and positive ROI, while identifying 1,041 papers relating to NHS shifts. While AI is efficient for initial filtering, human expertise remains necessary for later stages of complex screening to ensure nuanced criteria are correctly interpreted. The approach is described as scalable and repeatable, with an intent to share the methodology with other NHS colleagues if approved.
<!-- synthesis-claim:62e25e9809382f62b0eff024fa7ff130ffbc06c437c45f9f61ae9393812f5241 -->

## Related

- [[AI-assisted evidence screening methodology]]

## Sources

- [HACA2025 - Day 2 - Targeting Care/ Advancing Analytics](<https://www.youtube.com/watch?v=t9lfe18fStM>); SHA-256: `62e25e9809382f62b0eff024fa7ff130ffbc06c437c45f9f61ae9393812f5241` <!-- synthesis-source:62e25e9809382f62b0eff024fa7ff130ffbc06c437c45f9f61ae9393812f5241 -->
