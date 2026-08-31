"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";

import { ChartShell } from "@/ui/charts/chart-shell";
import { categoricalChartColours, useChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";

export type FinancialSeries = {
  label: string;
  colour?: string;
  values: Array<number | null>;
};

export function FinancialsChart({
  compactValue,
  marginLabel,
  margins,
  periods,
  series,
}: {
  compactValue: (value: number) => string;
  marginLabel?: string;
  margins?: Array<number | null>;
  periods: string[];
  series: FinancialSeries[];
}) {
  const chartColours = useChartColours();
  const option = useMemo<EChartsOption | null>(() => {
    if (!periods.length) return null;
    return {
      animation: false,
      grid: { bottom: 16, containLabel: true, left: 8, right: 8, top: 34 },
      legend: { icon: "roundRect", textStyle: { color: chartColours.axis }, top: 0 },
      series: [
        ...series.map((item, index) => ({
          barMaxWidth: 30,
          data: item.values,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: item.colour ?? categoricalChartColours[index % categoricalChartColours.length],
          },
          name: item.label,
          type: "bar" as const,
        })),
        ...(margins && marginLabel
          ? [{
              data: margins.map((value) => value == null ? null : value * 100),
              lineStyle: { color: chartColours.accent, width: 2 },
              name: marginLabel,
              showSymbol: false,
              type: "line" as const,
              yAxisIndex: 1,
            }]
          : []),
      ],
      tooltip: { backgroundColor: chartColours.tooltip, borderWidth: 0, textStyle: { color: chartColours.canvas }, trigger: "axis" },
      xAxis: {
        axisLabel: { color: chartColours.axis },
        axisLine: { lineStyle: { color: chartColours.border } },
        axisTick: { show: false },
        data: periods,
        type: "category",
      },
      yAxis: [
        {
          axisLabel: { color: chartColours.axis, formatter: compactValue },
          splitLine: { lineStyle: { color: chartColours.grid, type: "dashed" } },
          type: "value",
        },
        {
          axisLabel: { color: chartColours.axis, formatter: "{value}%" },
          splitLine: { show: false },
          type: "value",
        },
      ],
    };
  }, [chartColours, compactValue, marginLabel, margins, periods, series]);
  const chartRef = useECharts(option);

  return (
    <ChartShell ariaLabel={marginLabel ?? "Financial trend"} empty={!periods.length} height={380}>
      <div ref={chartRef} style={{ height: "100%", width: "100%" }} />
    </ChartShell>
  );
}
