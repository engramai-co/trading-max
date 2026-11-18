import { describe, expect, it } from "vitest";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { readingText } from "./chart-readout";
import { candleValues, previousCloses, priceGapConnectors, priceReading, priceSlots, type PriceBar } from "./research-price-candles";

function bar(date: string, close = 100): PriceBar {
  return { date, open: close - 2, close, high: close + 1, low: close - 3,
    volume: 200, sma20: null, sma50: null, sma200: null };
}

describe("price bars and period display", () => {
  it("reads pence OHLC and the absolute change in the panel’s displayed pounds", () => {
    const reading = priceReading({ bar: { ...bar("2026-02-03", 3100), open: 3000, high: 3150, low: 2950 },
      unit: "GBp", previous: 3050, time: "3 Feb", candle: true, labels: { change: "Change", volume: "Volume" } });
    expect(reading.ohlc).toEqual({ close: "31.00", open: "30.00", high: "31.50", low: "29.50", change: "+0.50 · +1.64%", tone: "up" });
  });
  it("reads a candle as the close and its move, then open, high, low and volume", () => {
    const bar = { date: "2026-10-08", open: 336.82, high: 341.57, low: 335.9, close: 340.42, volume: 34_400_000, sma20: null, sma50: null, sma200: null };
    const labels = { change: "Change", volume: "Volume" };
    const reading = priceReading({ bar, unit: "USD", previous: 336.89, time: "8 Oct", candle: true, volume: "34.4m", labels });
    expect(reading).toEqual({
      time: "8 Oct",
      ohlc: { close: "340.42", change: "+3.53 · +1.05%", tone: "up", open: "336.82", high: "341.57", low: "335.90", volume: "34.4m" },
    });
    // No currency or interval beside the figures: the panel names them once.
    expect(readingText(reading, "en")).toBe("8 Oct\nClose 340.42 +3.53 · +1.05%\nOpen 336.82\nHigh 341.57\nLow 335.90\nVolume 34.4m");
    expect(priceReading({ bar, unit: "USD", previous: 341.5, time: "8 Oct", candle: false, labels })).toEqual({
      time: "8 Oct",
      primary: { value: "340.42" },
      groups: [[{ label: "Change", value: "\u22121.08 · \u22120.32%", tone: "down" }]],
    });
    expect(priceReading({ bar, unit: "USD", time: "8 Oct", candle: true, labels }).ohlc?.change).toBeUndefined();
  });

  it("measures intraday moves from the previous session's last bar and daily moves from the bar before", () => {
    const points = ["2026-11-09T20:55Z", "2026-11-10T14:30Z", "2026-11-10T14:35Z"].map((date, i) => bar(date, 100 + i));
    expect(previousCloses(points, true, (date) => date.slice(0, 10))).toEqual([null, 100, 100]);
    expect(previousCloses(points, false, (date) => date.slice(0, 10))).toEqual([null, 100, 101]);
  });

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
