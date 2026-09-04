---
title: "Statistical modeling of boarding-related harm"
type: concept
tags: ["regression analysis", "confounding variables", "statistical methodology"]
links: ["Medical patient boarding and its systemic impacts"]
---

# Statistical modeling of boarding-related harm

Statistical modeling, specifically regression analysis, is employed to isolate the association between boarding exposure and patient outcomes by controlling for confounders. This methodology allows analysts to distinguish the specific effect of waiting times from other variables, translating complex data into impactful statements for both lay audiences and experts. A multi-year national data study using this approach concluded that England's waiting times led to up to 14,000 needless deaths annually.
<!-- synthesis-claim:8278ef9eb6c1f477ce53d510d40b7ae59ff0f46981e766407a5a529526daa3a4 -->

To ensure validity, the analysis accounts for several confounding variables. Patient demographics include age, sex, deprivation, co-morbidity scores, and activity history (number of A&E attendances in the last 60 days). Temporal variables include event time, month, and weekend status. Outcome-specific covariants are also controlled: for delay-mediated models, time to decision to admit (DTA) and 'no criteria to reside' (NCTR) status are included to account for exit block effects. For crowding-mediated outcomes, all other occupancy in the ED excluding the exposure group is considered.
<!-- synthesis-claim:8278ef9eb6c1f477ce53d510d40b7ae59ff0f46981e766407a5a529526daa3a4 -->

The exposure type is differentiated based on the impact being measured. For downstream impacts like mortality, the exposure is the time waiting for a bed (boarding time). For upstream impacts like ambulance handover times, the exposure is the level of the boarding queue at the time of the event. This distinction is crucial because handover times are causally impacted by the level of crowding rather than the specific delay experienced by individual patients after handover.
<!-- synthesis-claim:8278ef9eb6c1f477ce53d510d40b7ae59ff0f46981e766407a5a529526daa3a4 -->

## Related

- [[Medical patient boarding and its systemic impacts]]

## Sources

- [HACA2025 - Day 2 -  Improving System Flow](<https://www.youtube.com/watch?v=tGenwcQ6u8w>); SHA-256: `8278ef9eb6c1f477ce53d510d40b7ae59ff0f46981e766407a5a529526daa3a4` <!-- synthesis-source:8278ef9eb6c1f477ce53d510d40b7ae59ff0f46981e766407a5a529526daa3a4 -->
