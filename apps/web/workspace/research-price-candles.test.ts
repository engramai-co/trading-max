import { describe, expect, it } from "vitest";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { candleValues, priceGapConnectors, priceSlots, type PriceBar } from "./research-price-candles";

function bar(date: string, close = 100): PriceBar {
  return { date, open: close - 2, close, high: close + 1, low: close - 3,
    volume: 200, sma20: null, sma50: null, sma200: null };
}

describe("price bars and period display", () => {
  it("takes a missing OHLC leg out of just that candle", () => {
    const points = [bar("2026-11-02"), { ...bar("2026-11-03"), high: null }, bar("2026-11-04", 105)];
    expect(candleValues(points)).toEqual([[98, 100, 97, 101], [null, null, null, null], [103, 105, 102, 106]]);
    expect(priceGapConnectors([100, null, 105])).toEqual([[0, 100], [2, 105], [2, null]]);
  });

  it.each([
    ["2026-03-06", "14:30", "2026-03-09", "13:30"],
    ["2026-10-30", "13:30", "2026-11-02", "14:30"],
  ])("preserves the New York market open across US DST without inventing closure gaps", (last, before, next, after) => {
    const first = bar(`${last}T${before}:00Z`);
    const second = bar(`${next}T${after}:00Z`);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", dateStyle: "short" });
    const localDate = (date: string) => day.format(new Date(date));
    expect(priceSlots([first, second], "5m", localDate).flatMap((slot) => slot.bar ? [slot.bar.date] : ["gap"])).toEqual([first.date, second.date]);
    const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
    expect([first, second].map(({ date }) => localTime.format(new Date(date)))).toEqual(["09:30", "09:30"]);
    const later = bar(new Date(Date.parse(second.date) + 600_000).toISOString());
    expect(priceSlots([second, later], "5m", localDate).map(({ index }) => index)).toEqual([0, -1, 1]);
  });

  it("separates an exchange holiday from an unknown intraday slot", () => {
    const points = ["2026-11-25T20:55Z", "2026-11-27T14:30Z", "2026-11-27T14:40Z"].map((stamp) => bar(stamp));
    const slots = priceSlots(points, "5m", (stamp) => stamp.slice(0, 10));
    expect(slots.filter((slot) => slot.bar == null).map(({ date }) => date)).toEqual(["2026-11-27T14:35:00.000Z"]);
  });

  it.each([10, 30, 60])("keeps original complete five-minute closes at %i-minute display density", (minutes) => {
    const count = minutes / 5;
    const dates = Array.from({ length: count * 4 }, (_, i) => new Date(Date.UTC(2026, 10, 2, 14, i * 5)).toISOString());
    // Whole interior bucket three was lost at the source; it stays a gap.
    const values = dates.map((_, i) => i >= 2 * count && i < 3 * count ? null : i + 100);
    const result = historySeries(dates, values, true, {
      categories: dates, rowIndexes: values.map((value, i) => value == null ? null : i),
      displayIntervalMinutes: minutes,
    });
    expect(result.filter(({ value }) => value[1] != null).map(({ value }) => value[0]))
      .toEqual([...new Set([0, count - 1, count * 2 - 1, count * 3, count * 4 - 1])]);
    expect(historyGapSeries(result)).toEqual([
      [count * 2 - 1, 100 + count * 2 - 1], [count * 3, 100 + count * 3], [count * 3, null],
    ]);
  });
});
