const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function providerUsagePresentation(usage) {
  const match = typeof usage?.period === "string"
    ? usage.period.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
    : null;
  if (
    usage?.hasWarning !== true ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    !Number.isSafeInteger(usage.warningThreshold) ||
    usage.warningThreshold < 1 ||
    usage.outputTokens <= usage.warningThreshold ||
    !match
  ) {
    return { hidden: true, text: "" };
  }
  const month = MONTHS[Number(match[2]) - 1];
  return {
    hidden: false,
    text: `Remote AI usage notice: your provider reported ${
      usage.outputTokens.toLocaleString("en-GB")
    } output tokens in ${month} ${
      match[1]
    }. Check your provider billing dashboard for actual costs and limits.`,
  };
}
