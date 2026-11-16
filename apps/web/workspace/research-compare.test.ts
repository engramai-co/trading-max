import { describe, expect, it } from "vitest";
import type { LineSeriesOption } from "echarts";
import { darkChartColours } from "@/ui/charts/palette";
import { chartColours } from "@/ui/theme";
import { compareReading, compareReturnsOption, compareStroke } from "./research-compare";

const tickers = ["AAPL", "MSFT", "GOOGL", "AMZN"];
const dates = ["2025-11-10", "2026-03-02", "2026-06-12"];
const returns = [[0, 0.04, 0.0825], [0, -0.1, -0.2229], [0, 0.12, 0.2423], [0, 0.01, -0.03]];
const ISO = /\d{4}-\d{2}-\d{2}/;

function lines(colours: typeof chartColours | typeof darkChartColours) {
  return compareReturnsOption(colours, tickers, dates, returns, "zh").series as LineSeriesOption[];
}

describe("company comparison returns", () => {
  for (const [scheme, colours] of [["light", chartColours], ["dark", darkChartColours]] as const) {
    it("draws each line, its legend swatch and its hover dot in one colour (" + scheme + ")", () => {
      lines(colours).forEach((series, index) => {
        const stroke = compareStroke(colours, index);
        expect(series.color).toBe(stroke.colour);
        expect(series.itemStyle?.color).toBe(stroke.colour);
        expect(series.lineStyle?.color).toBe(stroke.colour);
        expect(series.lineStyle?.type).toEqual(stroke.dashed ? [6, 4] : "solid");
      });
    });

    it("keys every reading row with its own line's stroke (" + scheme + ")", () => {
      const series = lines(colours);
      const reading = compareReading(tickers, dates, returns, colours, 2, "zh")!;
      const rows = [{ label: reading.primary!.label!, key: reading.primary!.key! }, ...reading.groups![0].map((row) => ({ label: row.label, key: row.key! }))];
      expect(rows.map((row) => row.label).sort()).toEqual([...tickers].sort());
      for (const row of rows) {
        const line = series.find((item) => item.name === row.label)!;
        expect(row.key.colour).toBe(line.lineStyle?.color);
        expect(Boolean(row.key.dashed)).toBe(line.lineStyle?.type !== "solid");
      }
    });
  }

  it("keeps cobalt for the researched company and gain or loss colours out of the lines", () => {
    const series = lines(chartColours);
    expect(series[0].color).toBe(chartColours.brand);
    for (const line of series.slice(1)) expect([chartColours.brand, chartColours.positive, chartColours.negative]).not.toContain(line.color);
    expect(new Set(series.map((line) => line.color + "|" + JSON.stringify(line.lineStyle?.type))).size).toBe(series.length);
  });

  it("leads with the researched company and orders the others by return", () => {
    const reading = compareReading(tickers, dates, returns, chartColours, 2, "en")!;
    expect(reading.primary).toMatchObject({ label: "AAPL", value: "+8.25%", tone: "up" });
    expect(reading.groups![0].map((row) => row.label)).toEqual(["GOOGL", "AMZN", "MSFT"]);
    expect(reading.groups![0].find((row) => row.label === "MSFT")!.value).toBe("−22.29%");
  });

  it("adds the gap in percentage points when two companies are compared", () => {
    const reading = compareReading(["AAPL", "MSFT"], dates, returns.slice(0, 2), chartColours, 2, "zh")!;
    expect(reading.groups!.at(-1)).toEqual([{ label: "相差", value: "+30.54 pp", tone: "up" }]);
  });

  it("writes dates as the reader does, never as ISO strings", () => {
    const option = compareReturnsOption(chartColours, tickers, dates, returns, "zh");
    const axis = option.xAxis as { axisLabel: { formatter: (value: string) => string } };
    for (const date of dates) expect(axis.axisLabel.formatter(date)).not.toMatch(ISO);
    for (let index = 0; index < dates.length; index++) {
      const reading = compareReading(tickers, dates, returns, chartColours, index, "en")!;
      expect(reading.time).not.toMatch(ISO);
      expect(JSON.stringify(reading)).not.toMatch(/series\d/);
    }
  });
});
