export const priceRanges = [
  "1D",
  "5D",
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "2Y",
  "ALL",
];
export const priceIntervals = ["15m", "60m", "1d", "1wk"];

/** Security OHLC history, independent of the portfolio's ten-minute NAV record. */
export function defaultPriceInterval(range: string) {
  return range === "1D" || range === "5D"
    ? "15m"
    : range === "ALL"
      ? "1wk"
      : "1d";
}

export function supportsPriceRange(interval: string, range: string) {
  if (interval === "15m") return ["1D", "5D", "1M"].includes(range);
  if (interval === "60m") return !["2Y", "ALL"].includes(range);
  return (
    interval === "1d" || (interval === "1wk" && !["1D", "5D"].includes(range))
  );
}

export function resolvePriceInterval(
  range: string,
  requested: string | null,
  full: boolean,
) {
  return full && requested && supportsPriceRange(requested, range)
    ? requested
    : defaultPriceInterval(range);
}

export function incompletePriceRange(dates: string[], range: string) {
  if (!dates.length || range === "ALL") return false;
  const sessions = [...new Set(dates.map((date) => date.slice(0, 10)))];
  if (range === "1D" || range === "5D")
    return sessions.length < (range === "1D" ? 1 : 5);
  const first = Date.parse(sessions[0]);
  const last = new Date(sessions.at(-1)!);
  const start = new Date(last);
  if (range === "YTD") start.setUTCMonth(0, 1);
  else
    start.setUTCMonth(
      start.getUTCMonth() -
        ({ "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 }[range] ?? 3),
    );
  // Weekends, market holidays and weekly bars can move the first available bar.
  return first > start.getTime() + 7 * 86_400_000;
}
