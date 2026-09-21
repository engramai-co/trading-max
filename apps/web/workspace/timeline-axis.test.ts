import { describe, expect, it } from "vitest";
import { shortTimelineTicks, timelineAxis } from "./timeline-axis";
import { historySeries } from "@/lib/portfolio/series";
import { omitPortfolioWeekendDisplayWindow } from "@/lib/chart-domain";

describe("short-range timestamps", () => {
  it("uses the available width without crowding the current-time label", () => {
    const categories = Array.from({ length: 62 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 21, 6, i * 10)).toISOString());
    for (const count of [4, 5, 8]) {
      const ticks = shortTimelineTicks(categories, count);
      expect(ticks.length).toBeLessThanOrEqual(count);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(61);
      const gaps = ticks.slice(1).map((tick, i) => tick - ticks[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.max(...gaps) / 2);
    }
    expect(shortTimelineTicks(categories, 8).length).toBeGreaterThan(4);
  });
  it("spreads five-day ticks across plotted time, preserving the weekend fold and source rows", () => {
    const categories = Array.from({ length: 6 * 144 + 61 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 14, 23, i * 10)).toISOString());
    const timeline = omitPortfolioWeekendDisplayWindow({ categories, rowIndexes: categories.map((_, i) => i % 7 ? i : null) });
    const before = structuredClone(timeline);
    for (const count of [4, 5, 8]) {
      const ticks = shortTimelineTicks(timeline.categories, count);
      expect(ticks.length).toBeLessThanOrEqual(count);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(timeline.categories.length - 1);
      const gaps = ticks.slice(1).map((tick, i) => tick - ticks[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.max(...gaps) / 2);
      expect(ticks.map((index) => timeline.categories[index]).every((date) => Number.isFinite(Date.parse(date)))).toBe(true);
    }
    expect(timeline).toEqual(before);
  });
  it("handles empty and single-observation windows", () => {
    expect(shortTimelineTicks([], 5)).toEqual([]);
    expect(shortTimelineTicks(["2026-09-21T12:00:00Z"], 5)).toEqual([0]);
  });
});

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
