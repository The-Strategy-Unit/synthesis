import assert from "node:assert/strict";

import { providerUsagePresentation } from "./provider_usage.js";

Deno.test("provider usage warning is based on reported remote usage", () => {
  assert.deepEqual(
    providerUsagePresentation({
      period: "2026-09",
      outputTokens: 1_000_000,
      warningThreshold: 1_000_000,
      hasWarning: false,
    }),
    { hidden: true, text: "" },
  );
  assert.deepEqual(
    providerUsagePresentation({
      period: "2026-09",
      outputTokens: 1_000_001,
      warningThreshold: 1_000_000,
      hasWarning: true,
    }),
    {
      hidden: false,
      text:
        "Remote AI usage notice: your provider reported 1,000,001 output tokens in September 2026. Check your provider billing dashboard for actual costs and limits.",
    },
  );
  assert.deepEqual(providerUsagePresentation(null), {
    hidden: true,
    text: "",
  });
  assert.deepEqual(
    providerUsagePresentation({
      period: "2026-09",
      outputTokens: 10,
      warningThreshold: 1_000_000,
      hasWarning: true,
    }),
    { hidden: true, text: "" },
  );
});
