import { describe, expect, it } from "vitest";
import type { ChartColours } from "@/ui/charts/palette";
import { timelineOption, type TimelineLayer } from "./timeline-option";

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
