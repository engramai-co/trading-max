"use client";

import { useLocale } from "@/components/locale-provider";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { useECharts } from "@/ui/charts/use-echarts";
import { formatDate } from "@/ui/formatters";
import { useReducedMotion } from "@mantine/hooks";
import type {
  ECharts,
  EChartsOption,
  SeriesOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from "echarts";
import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { compact, number, numeric, percent } from "./data";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { historyGapSeries, historySeries } from "./history-series";
import { historyDay, type CalendarTimeline } from "./portfolio-history";
import { timelineAxis } from "./timeline-axis";
import { chartNumber } from "./research-chart-format";

function themeAxes<T extends XAXisComponentOption | YAXisComponentOption>(
  axes: T | T[] | undefined,
  colours: ChartColours,
): T | T[] | undefined {
  const theme = (axis: T): T => ({
    ...axis,
    nameTextStyle: { color: colours.axis, ...axis.nameTextStyle },
    axisLabel: { color: colours.axis, hideOverlap: true, ...axis.axisLabel },
    axisLine: {
      ...axis.axisLine,
      lineStyle: { color: colours.axis, ...axis.axisLine?.lineStyle },
    },
    axisTick: {
      ...axis.axisTick,
      lineStyle: { color: colours.axis, ...axis.axisTick?.lineStyle },
    },
    splitLine: {
      ...axis.splitLine,
      lineStyle: {
        color: colours.grid,
        type: "dashed",
        ...axis.splitLine?.lineStyle,
      },
    },
  });
  return Array.isArray(axes) ? axes.map(theme) : axes ? theme(axes) : undefined;
}

export function Plot({
  label,
  option,
  height = 300,
  research = false,
  controller,
  onZoom,
}: {
  label: string;
  option: (colours: ChartColours) => EChartsOption;
  height?: number;
  research?: boolean;
  controller?: RefObject<ECharts | null>;
  onZoom?: (chart: ECharts) => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const description = useId();
  const [reading, setReading] = useState("");
  const [pinned, setPinned] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const colours = useChartColours();
  const reduced = useReducedMotion();
  const settings = useMemo<EChartsOption>(() => {
    const custom = option(colours);
    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit", color: colours.text, fontSize: 11 },
      color: [
        colours.brand,
        colours.accent,
        colours.secondary,
        colours.negative,
      ],
      grid: { top: 20, right: 18, bottom: 30, left: 58 },
      ...custom,
      xAxis: themeAxes(custom.xAxis, colours),
      yAxis: themeAxes(custom.yAxis, colours),
      legend: Array.isArray(custom.legend)
        ? custom.legend.map((legend) => ({
            ...legend,
            textStyle: { color: colours.text, ...legend.textStyle },
          }))
        : custom.legend
          ? {
              ...custom.legend,
              textStyle: { color: colours.text, ...custom.legend.textStyle },
            }
          : undefined,
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        backgroundColor: colours.tooltip,
        textStyle: { color: colours.tooltipText, fontSize: 12 },
        borderWidth: 1,
        borderColor: colours.tooltipBorder,
        shadowBlur: 16,
        shadowColor: colours.tooltipShadow,
        shadowOffsetY: 4,
        padding: 12,
        confine: true,
        valueFormatter: (value) => chartNumber(value),
        axisPointer: {
          type: "line",
          lineStyle: { color: colours.axis, type: "dashed" },
        },
        ...(custom.tooltip && !Array.isArray(custom.tooltip)
          ? custom.tooltip
          : {}),
      },

      animation: !reduced && custom.animation !== false,
      animationDuration: 350,
      animationDurationUpdate: 180,
    };
  }, [colours, option, reduced]);
  const internal = useRef<ECharts | null>(null);
  const selected = useRef(0);
  const control = controller ?? internal;
  const ref = useECharts(
    settings,
    research ? "research" : "core",
    control,
    onZoom,
  );
  const dismiss = () => {
    control.current?.setOption({ tooltip: { alwaysShowContent: false } });
    control.current?.dispatchAction({ type: "hideTip" });
    setPinned(false);
    setReading("");
  };
  return (
    <div className="mx-plot" style={{ height }}>
      <div
        role="group"
        aria-roledescription={t("交互图表", "Interactive chart")}
        aria-label={label}
        aria-describedby={description}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.pointerType === "touch")
            touchStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (
            event.pointerType !== "touch" ||
            !start ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
          )
            return;
          if (pinned) {
            dismiss();
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          control.current?.setOption({ tooltip: { alwaysShowContent: true } });
          control.current?.dispatchAction({
            type: "showTip",
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          });
          setPinned(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (pinned || reading) {
              event.preventDefault();
              event.stopPropagation();
            }
            dismiss();
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const series = Array.isArray(settings.series)
            ? settings.series[0]
            : settings.series;
          const count =
            series && "data" in series && Array.isArray(series.data)
              ? series.data.length
              : 0;
          if (!count) return;
          selected.current =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? count - 1
                : Math.max(
                    0,
                    Math.min(
                      count - 1,
                      selected.current + (event.key === "ArrowRight" ? 1 : -1),
                    ),
                  );
          control.current?.dispatchAction({
            type: "showTip",
            seriesIndex: 0,
            dataIndex: selected.current,
          });
          setReading(chartReading(settings, selected.current, locale, t));
        }}
        ref={ref}
        style={{ height: "100%", width: "100%" }}
      />
      <span id={description} className="sr-only">
        {t(
          "左右方向键查看相邻读数，Home 和 End 到首尾，Escape 关闭。触控轻点固定读数，再次轻点关闭。",
          "Use arrow keys for adjacent readings, Home and End for the first and last point, and Escape to dismiss. Tap to pin a reading, then tap again to dismiss.",
        )}
      </span>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reading}
      </span>
      {pinned && (
        <button type="button" className="mx-chart-dismiss" onClick={dismiss}>
          {t("关闭读数", "Dismiss reading")}
        </button>
      )}
    </div>
  );
}

function chartReading(
  option: EChartsOption,
  index: number,
  locale: string,
  t: ReturnType<typeof useCopy>,
): string {
  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  const valueAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
  const series = Array.isArray(option.series) ? option.series : [option.series];
  const missing = t("无数据", "No data");
  const format = (v: unknown): string =>
    typeof v === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(v)
      : v == null
        ? missing
        : String(v);
  const coordinate = (
    value: unknown,
    axis: XAXisComponentOption | YAXisComponentOption | undefined,
    fallback: (value: unknown) => string,
  ): string => {
    if (typeof value !== "number") return fallback(value);
    if (axis?.type === "category") {
      const entry = axis.data?.[value];
      return format(entry && typeof entry === "object" ? entry.value : entry);
    }
    if (axis?.type === "time") return new Date(value).toLocaleString(locale);
    if (axis?.type === "value" || axis?.type === "log") {
      const formatter = axis.axisLabel?.formatter;
      if (typeof formatter === "function")
        return String(formatter(value, index, undefined))
          .replace(/\{[^{}|]+\|([^{}]*)\}/g, "$1")
          .replace(/\s+/g, " ");
      if (typeof formatter === "string")
        return formatter.replace("{value}", format(value));
    }
    return fallback(value);
  };
  return series
    .flatMap((s) => {
      if (!s || s.silent || !("data" in s) || !Array.isArray(s.data)) return [];
      const raw = s.data[index];
      const value =
        raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
      const axis =
        axes[
          "xAxisIndex" in s && typeof s.xAxisIndex === "number"
            ? s.xAxisIndex
            : 0
        ];
      const category =
        axis && "data" in axis && Array.isArray(axis.data)
          ? axis.data[index]
          : null;
      const heading = [category, s.name].filter((v) => v != null).join(" · ");
      const valueAxis =
        valueAxes[
          "yAxisIndex" in s && typeof s.yAxisIndex === "number"
            ? s.yAxisIndex
            : 0
        ];
      const valueFormatter = !Array.isArray(option.tooltip)
        ? option.tooltip?.valueFormatter
        : undefined;
      const axisFormatter = valueAxis?.axisLabel?.formatter;
      const formatReading = (v: unknown) => {
        if (v == null || typeof v !== "number") return format(v);
        if (typeof valueFormatter === "function")
          return String(valueFormatter(v, index));
        if (valueAxis?.type === "value" || valueAxis?.type === "log") {
          const formatter = valueAxis.axisLabel?.formatter;
          if (typeof formatter === "function")
            return String(formatter(v, index, undefined));
        }
        if (typeof axisFormatter === "string")
          return axisFormatter.replace("{value}", format(v));
        return format(v);
      };
      if (s.type === "candlestick" && Array.isArray(value)) {
        const labels = [
          t("开盘", "Open"),
          t("收盘", "Close"),
          t("最低", "Low"),
          t("最高", "High"),
        ];
        return `${heading}: ${value.map((v, i) => `${labels[i] ?? i} ${format(v)}`).join(", ")}`;
      }
      if (
        Array.isArray(value) &&
        axis?.type === "time" &&
        typeof value[0] === "number"
      )
        return `${new Date(value[0]).toLocaleString(locale)} · ${s.name ?? ""}: ${value.slice(1).map(formatReading).join(", ")}`;
      if (Array.isArray(value) && value.length === 2)
        return `${heading}: ${coordinate(value[0], axis, format)}, ${coordinate(value[1], valueAxis, formatReading)}`;
      return `${heading}: ${Array.isArray(value) ? value.map((v, i) => (i === value.length - 1 ? formatReading(v) : format(v))).join(", ") : formatReading(value)}`;
    })
    .join("; ");
}

export type ChartLine = {
  name: string;
  values: Array<number | null>;
  colour?: "brand" | "accent" | "secondary" | "negative";
  dashed?: boolean;
  area?: boolean;
  type?: "line" | "bar";
  step?: "end";
};
export function HistoryChart({
  dates,
  lines,
  label,
  percentage = false,
  height = 300,
  intraday = false,
  timeline,
  emptyDescription,
  notes,
}: {
  dates: string[];
  lines: ChartLine[];
  label: string;
  percentage?: boolean;
  height?: number;
  intraday?: boolean;
  timeline?: CalendarTimeline;
  emptyDescription?: string;
  notes?: string[];
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (
    !dates.length ||
    (timeline && !timeline.rowIndexes.some((row) => row != null)) ||
    !lines.some((line) => line.values.some((v) => v != null))
  )
    return (
      <Empty
        title={t("还没有可展示的观测记录", "No observations to chart yet")}
        description={
          emptyDescription ??
          t(
            "完成数据更新后，曲线将在这里出现。",
            "Your chart will appear after data has been collected.",
          )
        }
      />
    );
  const categories = timeline?.categories ?? dates;
  const multipleDays =
    intraday && historyDay(categories[0]) !== historyDay(categories.at(-1)!);
  const formatAxisDate = (date: string | number) =>
    formatDate(
      date,
      locale,
      intraday && !multipleDays
        ? { hour: "2-digit", minute: "2-digit", timeZone }
        : {
            year: "numeric",
            day: "numeric",
            month: "short",
            timeZone: intraday ? timeZone : "UTC",
          },
    );
  const horizontalAxis = timeline
    ? timelineAxis(timeline, formatAxisDate)
    : {
        type: "time" as const,
        minInterval: intraday ? 60000 : 86400000,
        boundaryGap: [0, 0] as [number, number],
        axisLabel: { formatter: formatAxisDate },
      };
  return (
    <>
      <Plot
        label={label}
        height={height}
        option={(c) => ({
          xAxis: {
            ...horizontalAxis,
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: {
              ...horizontalAxis.axisLabel,
              hideOverlap: true,
              color: c.axis,
              margin: 16,
            },
          },
          yAxis: {
            type: "value",
            scale: true,
            axisLabel: {
              color: c.axis,
              formatter: (v: number) =>
                percentage
                  ? percent(v, false, 2)
                  : Math.abs(v) < 10000
                    ? number(v, 2)
                    : compact(v),
            },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          tooltip: {
            trigger: "axis",
            renderMode: "richText",
            confine: true,
            formatter: (input) => {
              const entries = Array.isArray(input) ? input : [input];
              const rows = entries.filter(
                (entry) =>
                  !String(entry.seriesId ?? "").startsWith("history-gap:") && Array.isArray(entry.value) && entry.value.at(-1) != null,
              );
              if (!rows.length) return "";
              const value = rows[0].value as [number, number];
              const row = timeline?.rowIndexes[value[0]];
              const timestamp = timeline
                ? row == null
                  ? null
                  : dates[row]
                : value[0];
              if (timestamp == null) return "";
              const date = formatDate(
                timestamp,
                locale,
                intraday
                  ? {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone,
                      timeZoneName: "short",
                    }
                  : {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    },
              );
              return [
                date,
                ...rows.map((entry) => {
                  const amount = (entry.value as [number, number])[1];
                  return `${entry.seriesName}: ${percentage ? percent(amount, true, 2) : chartNumber(amount)}`;
                }),
              ].join("\n");
            },
            valueFormatter: (input) => {
              const value = Array.isArray(input) ? input.at(-1) : input;
              return numeric(value) == null
                ? "—"
                : percentage
                  ? percent(value, true, 2)
                  : Number(value).toLocaleString("en-GB", {
                      maximumFractionDigits: 2,
                    });
            },
          },
          series: lines.flatMap((line, i) => {
            const colour =
              c[
                line.colour ??
                  (i === 0 ? "brand" : i === 1 ? "accent" : "secondary")
              ];
            const data = historySeries(dates, line.values, intraday, timeline);
            const gaps = line.type === "bar" ? [] : historyGapSeries(data);
            const single = line.values.filter((value) => value != null).length === 1;
            const primary = {
              type: line.type ?? "line",
              name: line.name,
              data,
              symbol: single ? "circle" : "none",
              showSymbol: single,
              symbolSize: 4,
              connectNulls: false,
              smooth: false,
              lineStyle: {
                width: line.dashed ? 1.5 : 2.5,
                color: colour,
                type: line.dashed ? "dashed" : "solid",
              },
              itemStyle: { color: colour },
              areaStyle: line.area
                ? { opacity: 0.08, color: colour }
                : undefined,
              emphasis: { focus: "series" },
              barMaxWidth: 24,
            } satisfies SeriesOption;
            return [primary, ...(gaps.length ? [{
              id: `history-gap:${i}`, type: "line" as const, data: gaps,
              silent: true, tooltip: { show: false }, symbol: "none", showSymbol: false,
              connectNulls: false,
              lineStyle: { color: colour, width: 1.5, type: "dashed" as const, opacity: 0.65 },
              emphasis: { disabled: true },
            } satisfies SeriesOption] : [])];
          }),
        })}
      />
      <details className="mx-chart-data">
        <summary>{t("查看精确数据", "View exact values")}</summary>
        <EvidenceTable
          label={label}
          rows={dates.map((date, index) => ({ date, index }))}
          columns={[
            { label: t("日期", "Date"), value: (row) => row.date },
            ...(notes
              ? [
                  {
                    label: t("来源与精度", "Source & precision"),
                    value: (row: { index: number }) => notes[row.index],
                  },
                ]
              : []),
            ...lines.map((line) => ({
              label: line.name,
              numeric: true,
              value: (row: { index: number }) =>
                percentage
                  ? percent(line.values[row.index], false, 2)
                  : number(line.values[row.index], 2),
            })),
          ]}
        />
      </details>
    </>
  );
}

export function Legend({
  items,
}: {
  items: Array<{ label: string; colour?: string }>;
}) {
  return (
    <div className="mx-chart-legend">
      {items.map((item, i) => (
        <span key={item.label}>
          <i
            style={{ background: item.colour ?? "var(--mx-chart-" + i + ")" }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function Bars({
  labels,
  values,
  label,
  percentage = false,
  height,
}: {
  labels: string[];
  values: Array<number | null>;
  label: string;
  percentage?: boolean;
  height?: number;
}) {
  const t = useCopy();
  if (!labels.length || values.every((v) => v == null))
    return (
      <Empty title={t("暂时没有这项数据", "This data is not available yet")} />
    );
  return (
    <Plot
      label={label}
      height={height ?? Math.max(190, labels.length * 38 + 36)}
      option={(c) => ({
        grid: { top: 10, bottom: 20, left: 112, right: 70 },
        tooltip: {
          valueFormatter: (value) => percentage ? percent(value, true, 2) : chartNumber(value),
        },
        xAxis: {
          type: "value",
          splitNumber: 3,
          axisLabel: {
            color: c.axis,
            hideOverlap: true,
            formatter: (v: number) =>
              percentage
                ? percent(v, false, 0)
                : Math.abs(v) < 10000
                  ? number(v, 2)
                  : compact(v),
          },
          splitLine: { lineStyle: { color: c.grid } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: labels,
          axisLabel: { color: c.text, width: 102, overflow: "truncate" },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "bar",
            name: label,
            barMaxWidth: 12,
            data: values.map((v) => ({
              value: v,
              itemStyle: {
                color: (v ?? 0) < 0 ? c.negative : c.brand,
                borderRadius: 3,
              },
            })),
            label: {
              show: true,
              position: "right",
              color: c.text,
              formatter: (p) =>
                numeric(p.value) == null
                  ? "—"
                  : percentage
                    ? percent(p.value)
                    : compact(p.value),
            },
          },
        ],
      })}
    />
  );
}
