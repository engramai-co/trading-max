import { describe, expect, it } from "vitest";
import type { ChartColours } from "@/ui/charts/palette";
import { timelineOption, type TimelineLayer } from "./timeline-option";
import { moneyTimelineLayout } from "./money-timeline-layout";

const colours = {
  brand: "green",
  accent: "gold",
  negative: "red",
  axis: "grey",
  text: "black",
  grid: "grey",
} as ChartColours;
const dates = ["2025-01-01", "2025-01-02", "2025-01-08"];
const layers: TimelineLayer[] = [
  { label: "Value", lines: [{ name: "NAV", values: [100, 110, 120] }] },
  { label: "P&L", lines: [{ name: "Result", values: [0, null, 20] }] },
  {
    label: "Drawdown",
    percentage: true,
    drawdown: true,
    lines: [{ name: "Decline", values: [0, 0, 0] }],
  },
];
const options = () =>
  timelineOption(dates, layers, colours, (time) =>
    new Date(time).toISOString().slice(0, 10),
  );

describe("shared performance timeline", () => {
  it("plots outage estimates with dashed fluctuations and exposes their source in hover cards", () => {
    const dates = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(2026, 9, 14, 12, i * 10)).toISOString());
    const values = [100, 102, 95, 108, 103, 101];
    const calendar = { categories: dates, rowIndexes: [0, 1, 2, 3, null, 5] };
    const provenance = dates.map((_, i) => ({ estimated: i > 0 && i < 4,
      note: i > 0 && i < 4 ? "Reconstructed estimate · hourly market prices" : "Broker observation" }));
    const option = timelineOption(dates, [{ label: "Value", lines: [{ name: "NAV", values, area: true }] }], colours,
      String, calendar, [], String, undefined, undefined, provenance);
    const series = option.series as Array<{ id?: string; data: unknown[]; lineStyle: { type?: string } }>;
    const estimate = series.find((s) => s.id === "history-estimate:0:0")!;
    expect(estimate.lineStyle.type).toBe("dashed");
    expect(estimate.data.slice(0, 4)).toEqual([0, 1, 2, 3].map((i) => ({ value: [i, values[i]], symbolSize: 0 })));
    expect(series[0].data).toEqual([0, 1, 2, 3, 4, 5].map((i) => ({ value: [i, i === 4 ? null : values[i]], symbolSize: 0 })));
    expect(estimate).toMatchObject({ silent: true, tooltip: { show: false } });
    expect(series.find((s) => s.id === "history-gap:0:0")?.lineStyle.type).toBe("dotted");
    const tooltip = option.tooltip as { formatter: (input: unknown) => string };
    expect(tooltip.formatter([{ seriesId: estimate.id, value: [2, 95] }, { value: [2, 95] }])).toContain("Reconstructed estimate");
    expect(tooltip.formatter([{ value: [0, 100] }])).toContain("Broker observation");
    expect(tooltip.formatter([{ seriesId: "history-gap:0:0", value: [5, 101] }])).toBe("");
  });
  it("changes only short-view labels, keeping every series and panel aligned", () => {
    const categories = Array.from({ length: 62 }, (_, i) =>
      new Date(Date.UTC(2026, 8, 21, 6, i * 10)).toISOString());
    const calendar = { categories, rowIndexes: categories.map((_, i) => i), displayIntervalMinutes: 10 };
    const format = (time: number) => new Date(time).toISOString().slice(11, 16);
    const before = timelineOption(categories, layers, colours, format, calendar);
    const after = timelineOption(categories, layers, colours, format, calendar, [], format, undefined,
      { locale: "en", timeZone: "UTC", intraday: true, clock: true });
    expect(after.series).toEqual(before.series);
    expect(after.grid).toEqual(before.grid);
    expect(JSON.stringify(after.yAxis)).toBe(JSON.stringify(before.yAxis));
    const axes = after.xAxis as Array<{ min: number; max: number; axisLabel: { customValues: number[] } }>;
    expect(axes.every((axis) => axis.min === 0 && axis.max === 61)).toBe(true);
    expect(axes.every((axis) => JSON.stringify(axis.axisLabel.customValues) === JSON.stringify(axes[0].axisLabel.customValues))).toBe(true);
    expect(axes[0].axisLabel.customValues.at(-1)).toBe(60);
    const tooltip = after.tooltip as { formatter: (input: unknown) => string };
    const beforeTooltip = before.tooltip as { formatter: (input: unknown) => string };
    expect(tooltip.formatter([{ value: [61, 110] }])).toBe(beforeTooltip.formatter([{ value: [61, 110] }]));
  });
  it("spaces each responsive date density evenly across the full timeline", () => {
    const categories = Array.from({ length: 70 * 12 }, (_, i) =>
      new Date(Date.UTC(2025, 11, 1, i * 2)).toISOString());
    const option = timelineOption(categories, layers, colours,
      (time) => new Date(time).toISOString().slice(0, 10),
      { categories, rowIndexes: categories.map((_, i) => i) });
    const variants = option.media as Array<{ option: { xAxis: Array<{ axisLabel: { customValues: number[] } }> } }>;
    for (const [index, count] of [5, 4, 3, 8].entries()) {
      const axes = variants[index].option.xAxis;
      const ticks = axes[0].axisLabel.customValues;
      expect(ticks).toHaveLength(count);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(69 * 12);
      const gaps = ticks.slice(1).map((tick, i) => tick - ticks[i]);
      // Rounding to a date boundary may differ by one day, never by a
      // whole stride from downsampling the desktop subset a second time.
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(12);
      expect(axes.every((axis) => JSON.stringify(axis.axisLabel.customValues) === JSON.stringify(ticks))).toBe(true);
    }
    expect(option.xAxis).toEqual(expect.arrayContaining([
      expect.objectContaining({ axisLabel: expect.objectContaining({ customValues: variants[3].option.xAxis[0].axisLabel.customValues }) }),
    ]));
  });
  it("keeps each unit on its own axis while aligning every layer to the same dates", () => {
    const option = options();
    const axes = option.xAxis as Array<{
      min: number;
      max: number;
      gridIndex: number;
    }>;
    expect(
      axes.every(
        (axis) =>
          axis.min === Date.parse(dates[0]) &&
          axis.max === Date.parse(dates[2]),
      ),
    ).toBe(true);
    expect(option.axisPointer).toEqual({ link: [{ xAxisIndex: "all" }] });
    const series = (option.series as Array<{ silent?: boolean }>).filter((s) => !s.silent) as Array<{
      xAxisIndex: number;
      yAxisIndex: number;
      data: unknown[];
    }>;
    expect(series.map((line) => [line.xAxisIndex, line.yAxisIndex])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(series[1].data[1]).toMatchObject({ value: [Date.parse(dates[1]), null] });
    expect(
      series.every(
        (line) =>
          (line.data[2] as { value: unknown }).value != null
          && JSON.stringify((line.data[2] as { value: unknown }).value) === JSON.stringify([Date.parse(dates[2]) - 1, null]),
      ),
    ).toBe(true);
  });
  it("reads all layers for the hovered date, retaining missing values and separate units", () => {
    const tooltip = options().tooltip as {
      formatter: (input: unknown) => string;
    };
    const label = tooltip.formatter([{ value: [Date.parse(dates[1]), 110] }]);
    expect(label).toContain("2025-01-02");
    expect(label).toMatch(/<dt>NAV<\/dt>\s*<dd[^>]*><span>£110.00<\/span>/);
    expect(label).toMatch(/<dt>Result<\/dt>\s*<dd[^>]*><span>—<\/span>/);
    expect(label).toMatch(/<dt>Decline<\/dt>\s*<dd[^>]*><span>0.00%<\/span>/);
    expect(
      tooltip.formatter([{ value: [Date.parse(dates[2]) - 1, null] }]),
    ).toBe("");
  });
  it("anchors to a real observation after a synthetic gap marker at the same position", () => {
    const option = timelineOption(dates, layers, colours, String, {
      categories: dates,
      rowIndexes: [0, null, 2],
    });
    const tooltip = option.tooltip as { formatter: (input: unknown) => string };
    expect((option.xAxis as Array<unknown>)[0]).toMatchObject({ type: "value", min: 0, max: 2 });
    expect(tooltip.formatter([{ value: [2, null] }, { value: [2, 120] }])).toContain("£120.00");
    expect(tooltip.formatter([{ value: [1, 110] }])).toBe("");
    expect(tooltip.formatter([{ value: [2, null] }])).toBe("");
  });
  it("does not show an artificial 100% range for an all-zero drawdown series", () => {
    const axes = options().yAxis as Array<{ min?: number; max?: number }>;
    expect(axes[2]).toMatchObject({ min: -0.01, max: 0 });
  });
});

describe("money timeline", () => {
  it.each([
    [0, 0, 0],
    [42, 410, 840],
    [-17, -35, -45],
    [-21715, 0, 29274],
    [-152, -500, 6200],
    [0, 0.00019, -0.00021],
  ])("includes zero and real extremes for P&L %s, %s, %s", (a, b, c) => {
    const values = [a, b, c];
    const drawdown = [0, 0, -Math.abs(c)];
    const moneyLayers = [
      layers[0],
      { ...layers[1], lines: [{ name: "P&L", values }] },
      { ...layers[2], percentage: false, lines: [{ name: "Drawdown", values: drawdown }] },
    ];
    const option = timelineOption(dates, moneyLayers, colours, String, undefined, [], String,
      undefined, undefined, undefined, moneyTimelineLayout(false));
    const [, pnl, decline] = option.yAxis as Array<{ min: number; max: number; interval: number }>;
    expect(pnl.min).toBeLessThanOrEqual(Math.min(0, ...values));
    expect(pnl.max).toBeGreaterThanOrEqual(Math.max(0, ...values));
    expect((-pnl.min / pnl.interval) % 1).toBeCloseTo(0);
    expect(Math.round((pnl.max - pnl.min) / pnl.interval)).toBeGreaterThanOrEqual(3);
    expect(Math.round((pnl.max - pnl.min) / pnl.interval)).toBeLessThanOrEqual(4);
    expect(decline.max).toBe(0);
    expect(decline.min).toBeLessThanOrEqual(Math.min(...drawdown));
    expect(Math.round(-decline.min / decline.interval)).toBeLessThanOrEqual(2);
  });

  it("keeps real marker observations in the plotted line even within a wider display bucket", () => {
    const calendar = { categories: dates, rowIndexes: [0, 1, 2], displayIntervalMinutes: 60 * 24 * 15 };
    const moneyLayers = [
      layers[0],
      { ...layers[1], markerDate: dates[1], lines: [{ name: "P&L", values: [0, 20, 5] }] },
      { ...layers[2], markerDate: dates[2], lines: [{ name: "Drawdown", values: [0, 0, -0.15] }] },
    ];
    const option = timelineOption(dates, moneyLayers, colours, String, calendar, [], String,
      undefined, undefined, undefined, moneyTimelineLayout(false));
    const series = option.series as Array<{ data: Array<{ value: number[] }>; markPoint?: { data: Array<{ coord: number[] }> } }>;
    expect(series[1].data.map((point) => point.value)).toContainEqual([1, 20]);
    expect(series[1].markPoint?.data).toEqual([{ name: "P&L", coord: [1, 20] }]);
    expect(series[2].markPoint?.data).toEqual([{ name: "Drawdown", coord: [2, -0.15] }]);
  });

  it("adds a real intraday extreme before the close on the shared daily axis", () => {
    const dated = ["2025-01-01", "2025-01-02T14:00:00Z", "2025-01-02T21:00:00Z", "2025-01-03"];
    const calendar = { categories: ["2025-01-01", "2025-01-02", "2025-01-03"], rowIndexes: [0, 2, 3], displayIntervalMinutes: 1440 };
    const moneyLayers = [
      { ...layers[0], lines: [{ name: "NAV", values: [100, 135, 120, 115] }] },
      { ...layers[1], markerDate: dated[1], lines: [{ name: "P&L", values: [0, 35, 20, 15] }] },
      { ...layers[2], lines: [{ name: "Drawdown", values: [0, 0, -0.15, -0.20] }] },
    ];
    const option = timelineOption(dated, moneyLayers, colours, String, calendar, [],
      (time) => new Date(time).toISOString(), undefined, undefined, undefined, moneyTimelineLayout(false));
    const series = option.series as Array<{ data: Array<{ value: number[] }>; markPoint?: { data: Array<{ coord: number[] }> } }>;
    expect(series[0].data.map((point) => point.value)).toContainEqual([1, 135]);
    expect(series[1].data.map((point) => point.value)).toEqual([[0, 0], [1, 35], [2, 20], [3, 15]]);
    expect(series[1].markPoint?.data[0].coord).toEqual([1, 35]);
    const tooltip = option.tooltip as { formatter: (input: unknown) => string };
    expect(tooltip.formatter([{ value: [1, 135] }])).toContain("2025-01-02T14:00:00.000Z");
  });
});
