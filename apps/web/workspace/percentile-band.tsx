"use client";

import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { ComponentProps } from "react";
import { Plot } from "./charts";

type Level = "P10–P90" | "P25–P75" | "mean ±1σ";
export type PercentileDistribution = {
  median: number;
  lowerQuartile?: number;
  upperQuartile?: number;
  lowerDecile?: number;
  upperDecile?: number;
  mean?: number;
  standardDeviation?: number;
};

export function percentileBand(
  distribution: PercentileDistribution | null | undefined,
  level: Level,
) {
  if (!distribution) return undefined;
  const { median, lowerQuartile, upperQuartile, lowerDecile, upperDecile, mean, standardDeviation } = distribution;
  if (level === "mean ±1σ") return mean == null || standardDeviation == null
    ? undefined : { low: mean - standardDeviation, high: mean + standardDeviation, middle: mean };
  const [low, high] = level === "P10–P90" ? [lowerDecile, upperDecile] : [lowerQuartile, upperQuartile];
  return low == null || high == null ? undefined : { low, high, middle: median };
}

/** Overlay statistics already calculated from the original observations. The
 * invisible extent series keeps the whole band inside the y axis without
 * adding navigable observations. Other series and marks pass through. */
export function PercentileBand({ option, distribution, level = "P25–P75", extent, ...plot }: ComponentProps<typeof Plot> & {
  distribution?: PercentileDistribution | null;
  level?: Level;
  extent: [number, number];
}) {
  const band = percentileBand(distribution, level);
  return <Plot {...plot} option={(colours) => {
    const base = option(colours);
    return band ? withBand(base, colours, extent, band) : base;
  }} />;
}

function withBand(base: EChartsOption, c: ChartColours, extent: [number, number], band: NonNullable<ReturnType<typeof percentileBand>>) {
  const [first, ...rest] = Array.isArray(base.series) ? base.series : base.series ? [base.series] : [];
  if (!first || first.type !== "line") return base;
  return {
    ...base,
    series: [{
      ...first,
      markArea: {
        silent: true,
        itemStyle: { color: c.axis, opacity: 0.12 },
        data: [[{ yAxis: band.low }, { yAxis: band.high }]],
      },
      markLine: {
        silent: true,
        symbol: "none",
        label: { show: false },
        lineStyle: { color: c.axis, type: [3, 3], width: 1 },
        data: [{ yAxis: band.middle }],
      },
    }, ...rest, {
      type: "line",
      data: [[extent[0], band.low], [extent[1], band.high]],
      silent: true,
      tooltip: { show: false },
      showSymbol: false,
      lineStyle: { opacity: 0 },
    }] satisfies SeriesOption[],
  };
}
