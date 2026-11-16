import { describe, expect, it } from "vitest";
import type { ChartColours } from "@/ui/charts/palette";
import { moneyTimelineReading } from "./money-readings";
import { timelineOption, type TimelineLayer } from "./timeline-option";
import { defaultTimelineFigures, timelineGaps, timelineReadout, timelineRows } from "./timeline-reading";

const colours = {
  brand: "#1768e5", accent: "#b06000", negative: "#c5221f", axis: "#6b7280", text: "#111827", grid: "#e5e7eb", tooltip: "#ffffff",
} as ChartColours;
const dates = ["2026-10-24", "2026-10-25", "2026-10-26"];
const t = (_zh: string, en: string) => en;
const key = (layer: number, line = 0) => ({ colour: layer + ":" + line });

describe("timeline readings", () => {
  it("keys every row and cursor dot to the colour its line is drawn in", () => {
    const layers: TimelineLayer[] = [{ label: "Return comparison", percentage: true, lines: [
      { name: "Portfolio TWR", values: [0, 0.01, -0.0781], colour: "brand", area: true },
      { name: "VOO", values: [0, 0.002, -0.0264], colour: "axis", dashed: true },
    ] }];
    const option = timelineOption(dates, layers, colours, String);
    const strokes = option.series
      .filter((series) => typeof series.name === "string" && series.name.includes(" · "))
      .map((series) => (series as { lineStyle: { color: string } }).lineStyle.color);
    const readout = timelineReadout({ rows: timelineRows(dates, layers), layers, colours, time: () => "26 Oct" });
    const position = Date.parse(dates[2]);
    const reading = readout.read(position)!;
    expect(strokes).toEqual([colours.brand, colours.axis]);
    expect(reading.primary?.key).toEqual({ colour: colours.brand });
    expect(reading.groups?.[0][0].key).toEqual({ colour: colours.axis, dashed: true });
    expect(readout.marks!(position).map((mark) => mark.colour)).toEqual(strokes);
  });

  it("gives one line no label, leaves missing values out and signs only results", () => {
    const value: TimelineLayer[] = [{ label: "Value", lines: [{ name: "NAV", values: [100, 110.5, 120] }] }];
    expect(defaultTimelineFigures(value)(1, { key })).toEqual({ primary: { value: "£110.50" } });
    const layers: TimelineLayer[] = [
      ...value,
      { label: "P&L", zeroBaseline: true, lines: [{ name: "Result", values: [0, null, 20] }] },
      { label: "Drawdown", percentage: true, drawdown: true, lines: [{ name: "Decline", values: [0, -0.0123, 0] }] },
    ];
    expect(defaultTimelineFigures(layers)(1, { key })).toEqual({
      primary: { label: "NAV", key: { colour: "0:0" }, value: "£110.50" },
      groups: [[{ label: "Decline", key: { colour: "2:0" }, value: "\u22121.23%", tone: "down" }]],
    });
  });

  it("adds one exception word, passes known gaps through and never reads a gap marker", () => {
    const layers: TimelineLayer[] = [{ label: "Value", lines: [{ name: "NAV", values: [100, 110, 120] }] }];
    const calendar = { categories: [...dates, "2026-10-27"], rowIndexes: [0, null, 1, 2] };
    const readout = timelineReadout({
      rows: timelineRows(dates, layers, calendar), layers, colours,
      time: (row) => ["24 Oct", "25 Oct", "26 Oct"][row],
      flag: (row) => (row === 1 ? "After gap" : undefined),
      gap: (position) => position > 0 && position < 2,
    });
    expect(readout.positions).toEqual([0, 2, 3]);
    expect(readout.read(1)).toBeNull();
    expect(readout.read(2)).toEqual({ time: "25 Oct", flag: "After gap", primary: { value: "£110.00" } });
    expect(readout.gap?.(1)).toBe(true);
    expect(readout.latest).toBe("£120.00");
  });

  it("finds the interval each dotted gap connector crosses", () => {
    const times = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(2026, 9, 14, 12, i * 10)).toISOString());
    const option = timelineOption(times, [{ label: "Value", lines: [{ name: "NAV", values: [100, 102, 95, 108, 103, 101] }] }], colours,
      String, { categories: times, rowIndexes: [0, 1, 2, 3, null, 5] });
    expect(timelineGaps(option.series)).toEqual([[3, 5]]);
  });
});

describe("money reading", () => {
  const input = {
    pnls: [0, 20873.83, 20900],
    pnlPercents: [0, 0.0962, 0.0963],
    drawdowns: [0, -954.53, 0],
    drawdownPercents: [0, -0.0044, 0],
    flows: [0, 0, 5000],
    valueLines: [
      { name: "Account value", values: [217000, 237863.4, 242890] },
      { name: "Cumulative net deposits", values: [186632, 186632, 191632] },
    ],
    percentage: false,
    valueLayer: 1,
    t,
  };

  it("leads with period net P&L, then the drawdown and the two keyed value lines", () => {
    expect(moneyTimelineReading(input)(1, { key })).toEqual({
      primary: { label: "Period net P&L", value: "+£20,873.83", tone: "up", detail: "+9.62% vs opening" },
      groups: [
        [{ label: "P&L drawdown", value: "\u2212£954.53", tone: "down", detail: "\u22120.44%" }],
        [
          { label: "Account value", key: { colour: "1:0" }, value: "£237,863" },
          { label: "Cumulative net deposits", key: { colour: "1:1" }, value: "£186,632" },
        ],
      ],
    });
  });

  it("leaves out a zero drawdown and shows period deposits only when money moved", () => {
    const reading = moneyTimelineReading(input);
    expect(reading(0, { key }).groups).toHaveLength(1);
    expect(reading(0, { key }).groups?.[0][1].detail).toBeUndefined();
    expect(reading(2, { key }).groups?.[0][1].detail).toBe("Period +£5,000");
  });

  it("swaps the leading figure and its detail for the percentage view", () => {
    expect(moneyTimelineReading({ ...input, percentage: true })(1, { key }).primary).toEqual({
      label: "Period net P&L", value: "+9.62%", tone: "up", detail: "+£20,873.83",
    });
  });
});
