import { drawdowns } from "@/lib/portfolio/math";
import { navNumber, periodReturn, type Scope } from "@/lib/portfolio/nav";
import type { NavPoint } from "@/lib/types";
import type { ChartColours } from "@/ui/charts/palette";
import type { LineDash } from "./chart-readout";
import type { ChartLine } from "./charts";
import { timelineLineColour, type TimelineLayer } from "./timeline-option";

export const ALL_BENCHMARKS = ["VOO", "QQQ", "VT"] as const;

type BenchmarkVisualKey = {
  colour: "comparison" | "text" | "secondary";
  dash: LineDash;
};

/** Stable per-ticker visual keys so every benchmark remains distinct in colour and monochrome across subsets. */
const BENCHMARK_STROKES: Record<string, BenchmarkVisualKey> = {
  VOO: { colour: "comparison", dash: "long" },
  QQQ: { colour: "text", dash: "dash-dot" },
  VT: { colour: "secondary", dash: "short" },
};

const FALLBACK_STROKES: readonly BenchmarkVisualKey[] = [
  BENCHMARK_STROKES.VOO,
  BENCHMARK_STROKES.QQQ,
  BENCHMARK_STROKES.VT,
];

/** Visual key for a benchmark ticker; falls back deterministically by position if an unknown ticker appears. */
export function benchmarkStroke(ticker: string, index = 0): BenchmarkVisualKey {
  return BENCHMARK_STROKES[ticker] ?? FALLBACK_STROKES[index % FALLBACK_STROKES.length];
}

/** Portfolio TWR in solid cobalt followed by each benchmark series with its ticker-keyed stroke. */
export function returnComparisonLines(
  points: NavPoint[],
  scope: Scope,
  comparisons: ReadonlyArray<{ name: string; values: Array<number | null> }>,
  portfolioName: string,
): ChartLine[] {
  return [
    {
      name: portfolioName,
      colour: "brand",
      area: true,
      values: points.map((point) =>
        periodReturn(
          navNumber(points[0], scope, "Twr"),
          navNumber(point, scope, "Twr"),
        ),
      ),
    },
    ...comparisons.map((entry, index): ChartLine => ({
      ...entry,
      ...benchmarkStroke(entry.name, index),
    })),
  ];
}

/** Drawdown counterparts for each return comparison line, keeping the same visual key without area fill. */
export function returnDrawdownLines(returnLines: readonly ChartLine[]): ChartLine[] {
  return returnLines.map((line) => ({
    ...line,
    values: drawdowns(line.values, true),
    area: false,
  }));
}

/** Both panes of the return-comparison timeline chart, sharing each series' visual key across panes. */
export function returnComparisonLayers(
  returnLines: ChartLine[],
  labels: { returns: string; drawdown: string },
  markers?: TimelineLayer["markers"],
  returnDrawdowns: ChartLine[] = returnDrawdownLines(returnLines),
): TimelineLayer[] {
  return [
    { label: labels.returns, lines: returnLines, percentage: true },
    {
      label: labels.drawdown,
      percentage: true,
      drawdown: true,
      markers,
      lines: returnDrawdowns,
    },
  ];
}

/** Legend entries whose colours and dash patterns match the plotted ECharts lines and reading keys. */
export function returnLegendItems(lines: readonly ChartLine[], colours: ChartColours) {
  return lines.map((line, index) => ({
    label: line.name,
    colour: timelineLineColour(colours, 0, index, line),
    dashed: line.dashed,
    dash: line.dash,
  }));
}
