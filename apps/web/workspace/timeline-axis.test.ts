import { describe, expect, it } from "vitest";
import { timelineAxis } from "./timeline-axis";
import { historySeries } from "./history-series";

describe("sampled trading-time axis", () => {
  it("keeps ten-minute spacing and clock labels while hovering between thirty-minute display points", () => {
    const categories = Array.from({ length: 49 }, (_, index) => new Date(Date.UTC(2026, 8, 8, 0, index * 10)).toISOString());
    const calendar = { categories, rowIndexes: categories.map((_, i) => i), displayIntervalMinutes: 30 };
    const axis = timelineAxis(calendar, (time) => new Date(time).toISOString().slice(11, 16));
    expect(axis).toMatchObject({ type: "value", min: 0, max: 48 });
    expect(axis.axisLabel.customValues).toEqual([0, 24, 48]);
    expect(axis.axisLabel.formatter(24)).toBe("04:00");
    const series = historySeries(categories, categories.map((_, i) => 100 + i), true, calendar);
    expect(series.map((p) => p.value[0])).toEqual([0, 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 48]);
  });
  it("bounds an empty display bucket with nulls while keeping readings at their actual times", () => {
    const dates = Array.from({ length: 8 }, (_, index) => new Date(Date.UTC(2026, 8, 8, 9, index * 10)).toISOString());
    const calendar = { categories: dates, rowIndexes: [0, 1, null, null, null, null, 6, 7], displayIntervalMinutes: 30 };
    const series = historySeries(dates, [100, 101, null, null, null, null, 106, 107], true, calendar);
    expect(series.map((p) => p.value)).toEqual([[0, 100], [1, 101], [3, null], [5, null], [6, 106], [7, 107]]);
    expect(calendar.rowIndexes[2]).toBeNull();
  });
});
