import { describe, expect, it } from "vitest";
import { readChartColours } from "@/ui/charts/palette";
import { chartColours, darkChartColours } from "@/tests/fixtures/theme-colours";
import { LINE_DASH_PATTERNS } from "./chart-readout";
import { seasonStroke } from "./research-seasonality";

const tokens: Record<string, string> = {
  "--chart-1": "#4a8ef5",
  "--chart-2": "#a1a1aa",
  "--foreground": "#f4f4f5",
  "--muted-foreground": "#a1a1aa",
};
const colours = readChartColours((name) => tokens[name] ?? "#27272a");

describe("seasonStroke", () => {
  it("keeps cobalt for the latest year's own line only", () => {
    expect(seasonStroke(colours, 0).colour).toBe(colours.brand);
    const benchmark = seasonStroke(colours, 0, true);
    expect(benchmark.colour).toBe(colours.comparison);
    expect(benchmark.colour).not.toBe(colours.brand);
    expect(benchmark.type).toEqual([2, 3]);
    expect(benchmark.dash).toBe("dot");
  });

  it("draws earlier years' benchmarks in the year's neutral colour", () => {
    expect(seasonStroke(colours, 1, true)).toMatchObject({ colour: colours.text, type: [2, 3] });
    expect(seasonStroke(colours, 2, true).colour).toBe(colours.axis);
  });

  for (const [scheme, palette] of [["light", chartColours], ["dark", darkChartColours]] as const) {
    it("gives every benchmark year a stroke of its own in the " + scheme + " scheme", () => {
      const drawn = (year: number, benchmark: boolean) => {
        const stroke = seasonStroke(palette, year, benchmark);
        return stroke.colour.toLowerCase() + "|" + JSON.stringify(stroke.type);
      };
      const years = [0, 1, 2, 3, 4];
      const benchmarks = years.map((year) => drawn(year, true));
      expect(new Set(benchmarks).size).toBe(years.length);
      // A benchmark never draws like a year's own path either.
      const own = new Set(years.map((year) => drawn(year, false)));
      expect(benchmarks.filter((stroke) => own.has(stroke))).toEqual([]);
    });
  }

  it("draws a benchmark's reading key with the pattern of its path", () => {
    for (const year of [0, 1, 2, 3, 4]) {
      const stroke = seasonStroke(colours, year, true);
      expect(stroke.dash).toBeDefined();
      expect(stroke.type).toEqual(LINE_DASH_PATTERNS[stroke.dash!].chart);
    }
  });
});

