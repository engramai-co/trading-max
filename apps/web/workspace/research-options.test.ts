import { describe, expect, it } from "vitest";
import { chartColours, darkChartColours } from "../tests/fixtures/theme-colours";
import { compactTick } from "@/workspace/data";
import {
  expiryStroke,
  gammaMarks,
  gammaReading,
  gammaSeries,
  gexFigure,
  interestByStrike,
  interestRows,
  interestSeries,
  MAX_EXPIRIES,
  payoffReading,
  payoffSeries,
  sideStroke,
  type GammaLine,
} from "./research-options";

const ISO = /\d{4}-\d{2}-\d{2}/;
const spots = [180, 200, 220];
const gammaLines: GammaLine[] = ["12 Dec", "19 Dec", "16 Jan", "20 Feb", "20 Mar"].map((name, index) => ({
  name,
  profile: spots.map((spot, at) => ({ spot, netGex: (at - 1) * 1_234_567_890 + index * 10_000_000 })),
}));
const names = { call: "Calls", put: "Puts" } as const;

describe("option charts read through the reading card", () => {
  for (const [scheme, colours] of [["light", chartColours], ["dark", darkChartColours]] as const) {
    it("draws each expiration's line, legend swatch and hover dot in one stroke (" + scheme + ")", () => {
      gammaSeries(colours, gammaLines).forEach((series, index) => {
        const stroke = expiryStroke(colours, index);
        expect(series.color).toBe(stroke.colour);
        expect(series.itemStyle?.color).toBe(stroke.colour);
        expect(series.lineStyle?.color).toBe(stroke.colour);
        expect(series.lineStyle?.type).toEqual(stroke.dashed ? [6, 4] : stroke.dotted ? "dotted" : "solid");
      });
      expect(gammaMarks(colours, gammaLines, 200).map((mark) => mark.colour))
        .toEqual(gammaLines.map((_, index) => expiryStroke(colours, index).colour));
    });

    it("keys every gamma reading row with its own line's stroke (" + scheme + ")", () => {
      const series = gammaSeries(colours, gammaLines.slice(0, 4));
      const reading = gammaReading(colours, gammaLines.slice(0, 4), 200, "en", "USD")!;
      const rows = [reading.primary!, ...reading.groups![0]];
      expect(rows.map((row) => row.label)).toEqual(gammaLines.slice(0, 4).map((line) => line.name));
      for (const row of rows) {
        const line = series.find((item) => item.name === row.label)!;
        expect(row.key!.colour).toBe(line.lineStyle?.color);
        expect(Boolean(row.key!.dashed)).toBe(Array.isArray(line.lineStyle?.type));
        expect(Boolean(row.key!.dotted)).toBe(line.lineStyle?.type === "dotted");
      }
    });

    it("colours open interest bars and their reading keys by side (" + scheme + ")", () => {
      const counts = [[1200, null], [800, 15_250]];
      const bars = interestSeries(colours, names, counts);
      expect(bars.map((bar) => bar.itemStyle?.color)).toEqual([sideStroke("call", colours), sideStroke("put", colours)]);
      expect(bars.map((bar) => bar.color)).toEqual([colours.comparison, colours.accent]);
      expect(interestRows(colours, names, counts, 1)).toEqual([
        { label: "Puts", value: "15,250", key: { colour: colours.accent, kind: "bar" } },
      ]);
      expect(interestRows(colours, names, counts, 0).map((row) => row.key!.colour)).toEqual(bars.map((bar) => bar.itemStyle?.color));
    });

    it("draws the payoff in cobalt over a quiet zero line (" + scheme + ")", () => {
      const [line] = payoffSeries(colours, "Expiry P/L", [[0, -500], [100, 0], [200, 500]]);
      expect(line.color).toBe(colours.brand);
      expect(line.lineStyle?.color).toBe(colours.brand);
      expect(line.markLine).toMatchObject({ silent: true, lineStyle: { color: colours.axis }, data: [{ yAxis: 0 }] });
    });
  }

  it("leads with the first expiration in solid cobalt and keeps the others apart and out of gain or loss colours", () => {
    const series = gammaSeries(chartColours, gammaLines);
    expect(series[0]).toMatchObject({ color: chartColours.brand, lineStyle: { type: "solid" } });
    for (const line of series.slice(1)) {
      expect([chartColours.brand, chartColours.positive, chartColours.negative]).not.toContain(line.color);
      expect(line.lineStyle?.type).not.toBe("solid");
    }
    expect(new Set(series.map((line) => line.color + "|" + JSON.stringify(line.lineStyle?.type))).size).toBe(series.length);
    // One zero line for the chart.
    expect(series.filter((line) => line.markLine).length).toBe(1);
  });

  it("allows only as many expirations as there are distinct strokes", () => {
    expect(MAX_EXPIRIES).toBe(5);
    for (const colours of [chartColours, darkChartColours]) {
      const strokes = Array.from({ length: MAX_EXPIRIES }, (_, index) => JSON.stringify(expiryStroke(colours, index)));
      expect(new Set(strokes).size).toBe(MAX_EXPIRIES);
    }
  });

  it("reads one expiration without a label and names the spot as the axis does", () => {
    const reading = gammaReading(chartColours, gammaLines.slice(0, 1), 180, "en", "USD")!;
    expect(reading).toEqual({ time: "180.00", primary: { value: "−1.235bn" } });
    expect(gammaReading(chartColours, gammaLines.slice(0, 1), 190, "en", "USD")).toBeNull();
  });

  it("tells apart net gamma the axis rounds together, with the typographic minus", () => {
    expect(compactTick(1_210_000_000, "en")).toBe(compactTick(1_240_000_000, "en"));
    expect(gexFigure(1_210_000_000, "en")).toBe("1.21bn");
    expect(gexFigure(1_240_000_000, "en")).toBe("1.24bn");
    expect(gexFigure(-1_234_567_890, "en")).toBe("−1.235bn");
    expect(gexFigure(-352_456_789, "en")).toBe("−352.5m");
    expect(gexFigure(-123_456_789, "zh")).toBe("−1.235亿");
  });

  it("sums open interest by strike and side", () => {
    const { strikes, counts } = interestByStrike([
      { strike: 210, side: "put", openInterest: 40 },
      { strike: 200, side: "call", openInterest: 100 },
      { strike: 200, side: "call", openInterest: 25 },
      { strike: 200, side: "put", openInterest: null },
    ]);
    expect(strikes).toEqual([200, 210]);
    expect(counts).toEqual([[125, null], [null, 40]]);
  });

  it("signs and tones the payoff reading, with pounds as £ and other currencies left to the axis", () => {
    expect(payoffReading("Underlying at expiry", 150, 1234.5, "GBP"))
      .toEqual({ time: "Underlying at expiry 150.00", primary: { value: "+£1,234.50", tone: "up" } });
    expect(payoffReading("到期标的价", 87.125, -250, "USD"))
      .toEqual({ time: "到期标的价 87.13", primary: { value: "−250.00", tone: "down" } });
    expect(payoffReading("Underlying at expiry", 100, 0.001, "USD").primary).toEqual({ value: "0.00", tone: undefined });
    for (const reading of [gammaReading(chartColours, gammaLines, 220, "zh", "USD"), payoffReading("x", 1, 1, "USD")]) {
      expect(JSON.stringify(reading)).not.toMatch(ISO);
      expect(JSON.stringify(reading)).not.toMatch(/series\d/);
    }
  });
});
