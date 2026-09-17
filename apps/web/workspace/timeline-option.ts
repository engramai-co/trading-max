import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { ChartLine } from "./charts";
import { numeric, percent } from "./data";
import { historyGapSeries, historySeries } from "./history-series";
import type { CalendarTimeline } from "./portfolio-history";
import { timelineTooltipCard, type TimelineTooltip } from "./timeline-tooltip";
import { timelineAxis } from "./timeline-axis";

export type TimelineLayer = {
  label: string;
  lines: ChartLine[];
  percentage?: boolean;
  drawdown?: boolean;
};

export function timelineOption(
  dates: string[],
  layers: TimelineLayer[],
  colours: ChartColours,
  formatDay: (time: number) => string,
  calendar?: CalendarTimeline,
  details: Array<{ label: string; values: Array<number | null>; percentage?: boolean }> = [],
  formatTimestamp = formatDay,
  tooltip?: TimelineTooltip,
): EChartsOption {
  const times = dates.map(Date.parse);
  const horizontalAxis = calendar ? timelineAxis(calendar, formatDay) : {
    type: "time" as const,
    minInterval: 86400000,
    boundaryGap: [0, 0] as [number, number],
    min: times[0],
    max: times.at(-1),
    axisLabel: { formatter: (value: string | number) => formatDay(typeof value === "string" ? Date.parse(value) : value) },
  };
  const top = (index: number) => (index === 0 ? 32 : 292 + (index - 1) * 152);
  return {
    useUTC: true,
    grid: layers.map((_, index) => ({
      outerBoundsMode: "none",
      left: 64,
      right: 12,
      top: top(index),
      height: index === 0 ? 210 : 106,
    })),
    graphic: layers.map((layer, index) => ({
      type: "text",
      left: 0,
      top: top(index) - 28,
      style: {
        text: `${layer.label} · ${layer.percentage ? "%" : "GBP"}`,
        fill: colours.text,
        fontSize: 12,
        fontWeight: 500,
      },
    })),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: layers.map((_, index) => ({
      ...horizontalAxis,
      gridIndex: index,
      axisLine: { show: false },
      axisTick: { show: false },
      axisPointer: { show: true, snap: true },
      axisLabel: {
        ...horizontalAxis.axisLabel,
        show: index === layers.length - 1,
        showMinLabel: true,
        showMaxLabel: true,
        alignMinLabel: "left",
        alignMaxLabel: "right",
        hideOverlap: true,
        color: colours.axis,
      },
      splitNumber: 4,
    })),
    yAxis: layers.map((layer, index) => {
      const observed = layer.lines
        .flatMap((line) => line.values)
        .filter((v): v is number => v != null);
      const allZero =
        observed.length > 0 && observed.every((value) => value === 0);
      return {
        type: "value",
        gridIndex: index,
        scale: true,
        boundaryGap: index === 0 ? ["8%", "8%"] : [0, 0],
        splitNumber: index === 0 ? 4 : 2,
        ...(layer.drawdown
          ? {
              max: 0,
              ...(allZero ? { min: layer.percentage ? -0.01 : -1 } : {}),
            }
          : {}),
        axisLabel: {
          color: colours.axis,
          formatter: (v: number) =>
            layer.percentage
              ? percent(v, false, 2)
              : v.toLocaleString("en-GB", {
                  notation: "compact",
                  maximumSignificantDigits: 5,
                }),
        },
        splitLine: { lineStyle: { color: colours.grid, type: "dashed" } },
      };
    }),
    tooltip: {
      trigger: "axis",
      renderMode: "html",
      className: "mx-chart-tooltip",
      enterable: false,
      transitionDuration: 0,
      displayTransition: false,
      confine: true,
      padding: 14,
      borderWidth: 1,
      borderColor: colours.tooltipBorder,
      backgroundColor: colours.tooltip,
      textStyle: { color: colours.tooltipText, fontSize: 13 },
      extraCssText: [
        "white-space:normal;border-radius:12px",
        `box-shadow:0 4px 16px ${colours.tooltipShadow}`,
        `--mx-tooltip-ink:${colours.tooltipText}`,
        `--mx-tooltip-muted:${colours.tooltipMuted}`,
        `--mx-tooltip-border:${colours.tooltipBorder}`,
        `--mx-tooltip-up:${colours.positive}`,
        `--mx-tooltip-down:${colours.negative}`,
        "",
      ].join(";"),
      formatter: (input) => {
        // Only actual plotted values can anchor the card, never a missing slot.
        const entries = Array.isArray(input) ? input : [input];
        const point = entries.find((entry) => !String(entry.seriesId ?? "").startsWith("history-gap:") && Array.isArray(entry.value) && numeric(entry.value[1]) != null);
        const time = numeric(
          Array.isArray(point?.value) ? point.value[0] : null,
        );
        const index = time == null ? -1 : calendar ? calendar.rowIndexes[time] ?? -1 : times.indexOf(time);
        if (index < 0) return "";
        return timelineTooltipCard(tooltip ?? {
          primary: layers[0]?.lines.map((line) => ({ ...line, label: line.name, percentage: layers[0].percentage })) ?? [],
          secondary: [
            ...layers.slice(1).flatMap((layer) => layer.lines.map((line) => ({ ...line, label: line.name, percentage: layer.percentage, signed: true }))),
            ...details,
          ],
        }, index, formatTimestamp(times[index]));
      },
    },
    series: layers.flatMap((layer, axis) =>
      layer.lines.flatMap((line, index) => {
        const colour =
          colours[
            line.colour ??
              (index === 0 ? "brand" : index === 1 ? "accent" : "secondary")
          ];
        const data = historySeries(dates, line.values, false, calendar);
        const gaps = historyGapSeries(data);
        const single = line.values.filter((value) => value != null).length === 1;
        const primary = {
          type: "line",
          name: `${layer.label} · ${line.name}`,
          xAxisIndex: axis,
          yAxisIndex: axis,
          data,
          connectNulls: false,
          symbol: single ? "circle" : "none",
          showSymbol: single,
          symbolSize: 4,
          emphasis: { scale: false },
          step: line.step,
          lineStyle: {
            color: colour,
            width: line.dashed ? 1.5 : 2.5,
            type: line.dashed ? "dashed" : "solid",
          },
          itemStyle: { color: colour },
          areaStyle: line.area ? { color: colour, opacity: 0.08 } : undefined,
        } satisfies SeriesOption;
        return [primary, ...(gaps.length ? [{
          id: `history-gap:${axis}:${index}`,
          type: "line" as const,
          xAxisIndex: axis,
          yAxisIndex: axis,
          data: gaps,
          silent: true,
          tooltip: { show: false },
          symbol: "none",
          showSymbol: false,
          connectNulls: false,
          step: line.step,
          lineStyle: { color: colour, width: 1.5, type: "dashed" as const, opacity: 0.65 },
          emphasis: { disabled: true },
        } satisfies SeriesOption] : [])];
      }),
    ),
  };
}
