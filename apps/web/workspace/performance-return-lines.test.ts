import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { benchmarkComparison } from "@/lib/portfolio/benchmark-comparison";
import type { BenchmarkPricePoint, NavPoint } from "@/lib/types";
import { chartColours, darkChartColours } from "../tests/fixtures/theme-colours";
import { LINE_DASH_PATTERNS } from "./chart-readout";
import { Legend } from "./charts";
import {
  ALL_BENCHMARKS,
  benchmarkStroke,
  returnComparisonLayers,
  returnComparisonLines,
  returnDrawdownLines,
  returnLegendItems,
} from "./performance-return-lines";
import { comparisonFigures, readingTone, signedPercent } from "./reading-format";
import { ReadingView } from "./reading-card";
import { timelineOption } from "./timeline-option";
import { timelineReadout, timelineRows } from "./timeline-reading";

const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];
const nav: NavPoint[] = dates.map((date, index) => ({
  date,
  total: 10_000 + index * 100,
  invest: 6_000 + index * 60,
  isa: 4_000 + index * 40,
  totalNetContributionsGbp: 10_000,
  investNetContributionsGbp: 6_000,
  isaNetContributionsGbp: 4_000,
  totalTwr: [0.1, 0.14, 0.11, 0.16][index],
  investTwr: [0.1, 0.14, 0.11, 0.16][index],
  isaTwr: [0.1, 0.14, 0.11, 0.16][index],
  totalDrawdown: [0, 0, -0.0263, 0][index],
  investDrawdown: [0, 0, -0.0263, 0][index],
  isaDrawdown: [0, 0, -0.0263, 0][index],
  household: null,
  cfd: null,
  cfdProxyDrawdown: null,
  flowStatus: "daily_official",
  intraday: false,
  valuationSource: "broker",
}));

const benchmarkSeries: Record<string, BenchmarkPricePoint[]> = {
  VOO: [100, 102, 99, 105].map((close, index) => ({ date: dates[index], close })),
  QQQ: [200, 206, 198, 212].map((close, index) => ({ date: dates[index], close })),
  VT: [50, 51, 50.5, 52].map((close, index) => ({ date: dates[index], close })),
};

type SeriesWithStroke = {
  name?: string;
  xAxisIndex?: number;
  yAxisIndex?: number;
  silent?: boolean;
  areaStyle?: unknown;
  lineStyle?: { color?: string; width?: number; type?: string | number[] };
};

function buildAllBenchmarks(colours: typeof chartColours | typeof darkChartColours, tickers: readonly string[] = ALL_BENCHMARKS) {
  const comparison = benchmarkComparison(nav, "total", benchmarkSeries, tickers);
  const returnLines = returnComparisonLines(comparison.points, "total", comparison.comparisons, "Portfolio TWR");
  const returnDrawdowns = returnDrawdownLines(returnLines);
  const layers = returnComparisonLayers(
    returnLines,
    { returns: "Return comparison", drawdown: "Period drawdown" },
    undefined,
    returnDrawdowns,
  );
  const pointDates = comparison.points.map((point) => point.date);
  const option = timelineOption(pointDates, layers, colours, String);
  const legendItems = returnLegendItems(returnLines, colours);
  const readout = timelineReadout({
    rows: timelineRows(pointDates, layers),
    layers,
    colours,
    time: (row) => pointDates[row],
    reading: (row, { grid, key }) => {
      const pane = grid === 1 ? 1 : 0;
      return comparisonFigures(
        (pane === 1 ? returnDrawdowns : returnLines).map((line, index) => ({
          item: {
            label: pane === 1 ? `${line.name} drawdown` : line.name,
            key: key(pane, index),
            value: signedPercent(line.values[row]),
            tone: readingTone((line.values[row] ?? 0) * 100),
          },
          change: line.values[row],
        })),
        pane === 0 ? "Difference" : undefined,
      );
    },
  });
  return { comparison, returnLines, returnDrawdowns, layers, option, legendItems, readout };
}

describe("all-benchmarks visual keys", () => {
  for (const [scheme, colours] of [["light", chartColours], ["dark", darkChartColours]] as const) {
    it("distinguishes every benchmark by its neutral dash pattern in both panes (" + scheme + ")", () => {
      const { returnLines, option } = buildAllBenchmarks(colours);
      const plotted = (option.series as SeriesWithStroke[]).filter((series) => !series.silent);
      expect(plotted).toHaveLength(8);

      for (const axisIndex of [0, 1]) {
        const paneSeries = plotted.filter((series) => series.yAxisIndex === axisIndex);
        expect(paneSeries).toHaveLength(4);
        const visualKeys = paneSeries.map((series) =>
          `${series.lineStyle?.color}|${JSON.stringify(series.lineStyle?.type)}`,
        );
        const dashPatterns = paneSeries.map((series) => JSON.stringify(series.lineStyle?.type));
        expect(new Set(visualKeys).size).toBe(4);
        expect(new Set(dashPatterns).size).toBe(4);

        const [portfolio, ...benchmarks] = paneSeries;
        expect(portfolio.lineStyle).toMatchObject({ color: colours.brand, width: 2, type: "solid" });
        expect(benchmarks.find((series) => series.name?.endsWith(" · VOO"))?.lineStyle).toMatchObject({
          color: colours.comparison, type: LINE_DASH_PATTERNS.long.chart,
        });
        for (const benchmark of benchmarks) {
          expect([colours.comparison, colours.text, colours.axis]).toContain(benchmark.lineStyle?.color);
          expect(benchmark.lineStyle?.type).not.toBe("solid");
          expect(benchmark.lineStyle?.type).not.toBe("dotted");
          expect(benchmark.lineStyle?.width).toBe(1.5);
        }
      }

      expect(returnLines.map((line) => line.name)).toEqual(["Portfolio TWR", "VOO", "QQQ", "VT"]);
    });

    it("matches legend swatches and keyboard/card reading keys to each plotted series (" + scheme + ")", () => {
      const { option, legendItems, readout } = buildAllBenchmarks(colours);
      const returnSeries = (option.series as SeriesWithStroke[]).filter((series) => !series.silent && series.yAxisIndex === 0);

      expect(legendItems).toHaveLength(4);
      const legendHtml = renderToStaticMarkup(createElement(Legend, { items: legendItems }));
      expect(legendHtml.match(/<path /g)).toHaveLength(3);

      legendItems.forEach((item, index) => {
        const line = returnSeries[index];
        expect(item.colour).toBe(line.lineStyle?.color);
        if (item.dash) {
          expect(line.lineStyle?.type).toEqual(LINE_DASH_PATTERNS[item.dash].chart);
          expect(legendHtml).toContain(`stroke="${item.colour}"`);
          expect(legendHtml).toContain(`stroke-dasharray="${LINE_DASH_PATTERNS[item.dash].swatch}"`);
        } else {
          expect(line.lineStyle?.type).toBe("solid");
          expect(legendHtml).toContain(`background:${item.colour}`);
        }
      });

      const lastPosition = readout.positions.at(-1)!;
      for (const grid of [undefined, 1] as const) {
        const reading = readout.read(lastPosition, grid === undefined ? undefined : { grid })!;
        const items = [reading.primary!, ...reading.groups![0]];
        expect(items).toHaveLength(4);
        const readingKeys = items.map((item) => `${item.key!.colour}|${item.key!.dash ?? "solid"}`);
        expect(new Set(readingKeys).size).toBe(4);

        const html = renderToStaticMarkup(createElement(ReadingView, { reading, locale: "en" }))
          .replace(/class="mx-reading-key(?: [^"]*)?"/g, 'class="mx-reading-key"');
        items.forEach((item, index) => {
          const line = returnSeries[index];
          expect(item.key!.colour).toBe(line.lineStyle?.color);
          if (item.key!.dash) {
            expect(line.lineStyle?.type).toEqual(LINE_DASH_PATTERNS[item.key!.dash].chart);
            expect(html).toContain(`<svg class="mx-reading-key" style="--key:${item.key!.colour}" aria-hidden="true" width="18" height="4"><path d="M0 2h18" stroke-dasharray="${LINE_DASH_PATTERNS[item.key!.dash].swatch}"></path></svg>${item.label}`);
          } else {
            expect(line.lineStyle?.type).toBe("solid");
            expect(html).toContain(`<i class="mx-reading-key" style="--key:${item.key!.colour}" aria-hidden="true"></i>`);
          }
        });
      }

      expect(readout.marks!(lastPosition).map((mark) => mark.colour)).toEqual([
        ...returnSeries.map((line) => line.lineStyle?.color),
        ...returnSeries.map((line) => line.lineStyle?.color),
      ]);
    });
  }

  it("keeps each benchmark ticker's visual key stable when only a subset is available", () => {
    const partial = buildAllBenchmarks(chartColours, ["QQQ", "VT"]);
    const singleVt = buildAllBenchmarks(chartColours, ["VT"]);

    expect(partial.returnLines.slice(1).map((line) => ({
      name: line.name,
      colour: line.colour,
      dash: line.dash,
    }))).toEqual([
      { name: "QQQ", ...benchmarkStroke("QQQ") },
      { name: "VT", ...benchmarkStroke("VT") },
    ]);

    expect(singleVt.returnLines.slice(1).map((line) => ({
      name: line.name,
      colour: line.colour,
      dash: line.dash,
    }))).toEqual([
      { name: "VT", ...benchmarkStroke("VT") },
    ]);
  });
});
