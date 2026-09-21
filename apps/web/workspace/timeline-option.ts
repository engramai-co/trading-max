import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { ChartLine } from "./charts";
import { numeric } from "@/lib/numeric";
import { percent } from "@/workspace/data";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import type { CalendarTimeline } from "@/lib/portfolio/history";
import { timelineTooltipCard, type TimelineTooltip } from "./timeline-tooltip";
import { shortTimelineTicks, timelineAxis } from "./timeline-axis";

export type TimelineLayer = {
  label: string;
  lines: ChartLine[];
  percentage?: boolean;
  drawdown?: boolean;
  zeroBaseline?: boolean;
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
  shortRange = false,
): EChartsOption {
  const times = dates.map(Date.parse);
  // Keep every date candidate: resampling an eight-label subset to five
  // produces uneven 2/2/1/2 strides at the compact breakpoint.
  const calendarAxis = calendar ? timelineAxis(calendar, formatDay, Infinity) : undefined;
  const shortDateLabels = shortRange && calendarAxis?.axisLabel.formatter(0).includes("\n");
  const ticksForWidth = (count: number) => {
    if (shortRange && calendar) return shortTimelineTicks(calendar.categories, count);
    const ticks = calendarAxis?.axisLabel.customValues;
    return ticks && (ticks.length <= count ? ticks
      : Array.from({ length: count }, (_, index) => ticks[Math.round(index * (ticks.length - 1) / (count - 1))]));
  };
  const horizontalAxis = calendarAxis ? {
    ...calendarAxis,
    axisLabel: { ...calendarAxis.axisLabel, customValues: ticksForWidth(8) },
  } : {
    type: "time" as const,
    minInterval: 86400000,
    boundaryGap: [0, 0] as [number, number],
    min: times[0],
    max: times.at(-1),
    axisLabel: { formatter: (value: string | number) => formatDay(typeof value === "string" ? Date.parse(value) : value) },
  };
  const top = (index: number) => (index === 0 ? 32 : 292 + (index - 1) * 196);
  const axisDensity = (count: number) => {
    const ticks = ticksForWidth(count);
    return {
      xAxis: layers.map(() => ({
        splitNumber: count - 1,
        ...(ticks ? { axisLabel: { customValues: ticks } } : {}),
      })),
    };
  };
  return {
    useUTC: true,
    // ECharts evaluates these against the chart container and re-applies them
    // on resize. The default restores up to eight labels when the panel widens.
    media: [
      { query: { maxWidth: 820 }, option: axisDensity(5) },
      { query: { maxWidth: 540 }, option: axisDensity(shortDateLabels ? 3 : 4) },
      ...(shortRange ? [{ query: { maxWidth: 300 }, option: axisDensity(shortDateLabels ? 2 : 3) }] : []),
      { option: axisDensity(8) },
    ],
    grid: layers.map((_, index) => ({
      outerBoundsMode: "none",
      left: 64,
      right: 12,
      top: top(index),
      height: index === 0 ? 210 : 150,
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
        margin: 16,
        formatter: (value: number) => {
          const [date, year] = horizontalAxis.axisLabel.formatter(value).split("\n");
          return year ? `{date|${date}}\n{year|${year}}` : `{date|${date}}`;
        },
        rich: {
          date: { color: colours.axis, fontSize: 12, lineHeight: 22 },
          year: { color: colours.axis, fontSize: 10, lineHeight: 18 },
        },
      },
      splitNumber: 7,
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
        const point = entries.find((entry) => !/^history-(gap|area):/.test(String(entry.seriesId ?? "")) && Array.isArray(entry.value) && numeric(entry.value[1]) != null);
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
          z: 3,
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
          markLine: layer.zeroBaseline && index === 0 ? {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: colours.axis, width: 1, type: "solid", opacity: 0.45 },
            data: [{ yAxis: 0 }],
          } : undefined,
        } satisfies SeriesOption;
        // Fill is a quiet visual silhouette. The solid/dashed strokes retain
        // observation boundaries; the fill never supplies hover values or rows.
        const area = line.area ? [{
          id: `history-area:${axis}:${index}`,
          type: "line" as const,
          xAxisIndex: axis,
          yAxisIndex: axis,
          data,
          z: 1,
          silent: true,
          tooltip: { show: false },
          symbol: "none",
          showSymbol: false,
          connectNulls: true,
          step: line.step,
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: colour, opacity: 0.07, origin: layer.zeroBaseline ? 0 : "auto" as const },
          emphasis: { disabled: true },
        } satisfies SeriesOption] : [];
        return [primary, ...area, ...(gaps.length ? [{
          id: `history-gap:${axis}:${index}`,
          type: "line" as const,
          xAxisIndex: axis,
          yAxisIndex: axis,
          data: gaps,
          z: 3,
          silent: true,
          tooltip: { show: false },
          symbol: "none",
          showSymbol: false,
          connectNulls: false,
          step: line.step,
          lineStyle: { color: colour, width: 2, type: "dashed" as const, opacity: 0.75 },
          emphasis: { disabled: true },
        } satisfies SeriesOption] : [])];
      }),
    ),
  };
}
