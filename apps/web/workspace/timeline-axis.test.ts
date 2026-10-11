import { describe, expect, it } from "vitest";
import { timelineAxis } from "./timeline-axis";
import { timelineLabels, type TimelineDisplay } from "./timeline-labels";
import { historySeries } from "@/lib/portfolio/series";
import { omitPortfolioWeekendDisplayWindow } from "@/lib/chart-domain";

describe("short-range timestamps", () => {
  const display: TimelineDisplay = { locale: "en", timeZone: "Europe/London", intraday: true, clock: true };
  it("uses round local hours without forcing the unrounded latest observation onto the axis", () => {
    const categories = Array.from({ length: 62 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 21, 6, i * 10)).toISOString());
    for (const count of [4, 5, 8]) {
      const plan = timelineLabels(categories, display);
      const ticks = plan.ticks(count);
      expect(ticks.length).toBeLessThanOrEqual(count);
      expect(ticks).not.toContain(61);
      expect(ticks.map(plan.label).every((label) => label.endsWith(":00"))).toBe(true);
    }
    expect(timelineLabels(categories, display).ticks(8).length).toBeGreaterThan(4);
  });
  it("spreads five-day ticks across plotted time, preserving the weekend fold and source rows", () => {
    const categories = Array.from({ length: 6 * 144 + 61 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 14, 23, i * 10)).toISOString());
    const timeline = omitPortfolioWeekendDisplayWindow({ categories, rowIndexes: categories.map((_, i) => i % 7 ? i : null) });
    const before = structuredClone(timeline);
    for (const count of [4, 5, 8]) {
      const plan = timelineLabels(timeline.categories, { ...display, clock: false });
      const ticks = plan.ticks(count);
      expect(ticks.length).toBeLessThanOrEqual(count);
      expect(ticks[0]).toBe(0);
      expect(ticks.map((index) => timeline.categories[index]).every((date) => Number.isFinite(Date.parse(date)))).toBe(true);
      expect(new Set(ticks.map(plan.label)).size).toBe(ticks.length);
    }
    expect(timeline).toEqual(before);
  });
  it("handles empty and single-observation windows", () => {
    expect(timelineLabels([], display).ticks(5)).toEqual([]);
    expect(timelineLabels(["2026-09-21T12:15:00Z"], display).ticks(5)).toEqual([0]);
  });
  it("shows five local calendar dates, not duplicate date/time pairs or a 23:50 cutoff", () => {
    const categories = Array.from({ length: 5 * 144 }, (_, i) => new Date(Date.UTC(2026, 9, 4, 23, i * 10)).toISOString());
    const plan = timelineLabels(categories, { ...display, locale: "zh", clock: false });
    expect(plan.ticks(8)).toEqual([0, 144, 288, 432, 576]);
    expect(plan.ticks(8).map(plan.label)).toEqual(["10月5日", "10月6日", "10月7日", "10月8日", "10月9日"]);
    expect(plan.context).toContain("2026年10月");
    expect(plan.context).toContain("伦敦");
    expect(plan.ticks(3)).toEqual([0, 288, 576]);
  });
  it("places day ticks in the selected timezone, including non-integral UTC offsets", () => {
    const categories = Array.from({ length: 3 * 144 }, (_, i) => new Date(Date.UTC(2026, 9, 5, 0, i * 10)).toISOString());
    const plan = timelineLabels(categories, { ...display, timeZone: "Asia/Kolkata", clock: false });
    expect(plan.ticks(8)).toEqual([0, 111, 255, 399]);
    const clock = timelineLabels(categories.slice(0, 144), { ...display, timeZone: "Asia/Kolkata" });
    expect(clock.ticks(8).map((i) => categories[i].slice(14, 16)).every((minute) => minute === "30")).toBe(true);
  });
  it("keeps days on real calendar boundaries over a daylight-saving transition", () => {
    const categories = Array.from({ length: 3 * 144 }, (_, i) => new Date(Date.UTC(2026, 9, 23, 23, i * 10)).toISOString());
    const plan = timelineLabels(categories, { ...display, clock: false });
    expect(plan.ticks(8)).toEqual([0, 144, 294]); // The middle London day has 25 hours.
    const repeatedHour = timelineLabels(categories.slice(144, 294), display);
    const labels = repeatedHour.ticks(30).map(repeatedHour.label);
    expect(labels.filter((label) => label === "01:00")).toHaveLength(1);
  });
  it("supports quarter-hour timezone offsets without inventing source observations", () => {
    const categories = Array.from({ length: 144 }, (_, i) => new Date(Date.UTC(2026, 9, 9, 0, i * 10)).toISOString());
    const before = [...categories];
    const plan = timelineLabels(categories, { ...display, timeZone: "Asia/Kathmandu" });
    const ticks = plan.ticks(8);
    expect(ticks.length).toBeGreaterThan(4);
    expect(ticks.every((tick) => tick % 1 === .5)).toBe(true);
    expect(ticks.map(plan.label)).toEqual(["06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "10 Oct", "03:00"]);
    expect(categories).toEqual(before);
  });
  it("marks midnight when a 1D chart crosses into another local date", () => {
    const categories = Array.from({ length: 144 }, (_, i) => new Date(Date.UTC(2026, 9, 8, 23, i * 10)).toISOString());
    const plan = timelineLabels(categories, { ...display, locale: "zh", timeZone: "Asia/Hong_Kong" });
    expect(plan.ticks(8).map(plan.label)).toContain("10月10日");
    expect(plan.context).toContain("2026");
    expect(plan.context).toContain("香港");
  });
  it("retains year context and treats daily records as dates, not timezone-shifted instants", () => {
    const plan = timelineLabels(["2025-12-31", "2026-01-01", "2026-01-02"], { ...display, clock: false, intraday: false, timeZone: "America/Los_Angeles" });
    expect(plan.ticks(8).map(plan.label)).toEqual(["31 Dec", "1 Jan", "2 Jan"]);
    expect(plan.context).toContain("2025");
    expect(plan.context).toContain("2026");
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
