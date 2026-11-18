"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate, formatReadingTime, type ReadingGranularity } from "@/ui/formatters";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import type {
  SeriesOption,
} from "echarts";
import { compact, number, percent } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { historyDay, type CalendarTimeline } from "@/lib/portfolio/history";
import { timelineAxis } from "./timeline-axis";
import type { ChartReadout, Reading, ReadingItem, ReadingKey } from "./chart-readout";
import { fixed, readingTone, signedPercent, signedPounds } from "./reading-format";

import { Plot } from "./plot";
export { Plot } from "./plot";

export type ChartLine = {
  name: string;
  values: Array<number | null>;
  colour?: "brand" | "accent" | "secondary" | "negative" | "text" | "axis";
  dashed?: boolean;
  area?: boolean;
  type?: "line" | "bar";
  step?: "end";
  markers?: Array<{ date: string; name: string }>;
};

/** A history line's stroke; its reading row and cursor dot use the same colour. */
export function historyLineColour(colours: ChartColours, line: Pick<ChartLine, "colour">, index: number) {
  return colours[line.colour ?? (index === 0 ? "brand" : index === 1 ? "accent" : "secondary")];
}

export function HistoryChart({
  dates,
  lines,
  label,
  percentage = false,
  currencyTick = false,
  height = 300,
  intraday = false,
  timeline,
  emptyDescription,
  notes,
  fullscreen = false,
  onBrush,
}: {
  dates: string[];
  lines: ChartLine[];
  label: string;
  percentage?: boolean;
  currencyTick?: boolean;
  height?: number;
  intraday?: boolean;
  timeline?: CalendarTimeline;
  emptyDescription?: string;
  notes?: string[];
  fullscreen?: boolean;
  onBrush?: (start: string, end: string) => void;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const colours = useChartColours();
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
  const axisZone = intraday ? timeZone : "UTC";
  const yearOf = (date: string | number) =>
    formatDate(date, locale, { year: "numeric", timeZone: axisZone });
  const latestYear = yearOf(categories.at(-1)!);
  // The year appears only on dates outside the latest year shown, so it marks
  // the boundary instead of repeating on every label.
  const formatAxisDate = (date: string | number) => {
    if (intraday && !multipleDays)
      return formatDate(date, locale, { hour: "2-digit", minute: "2-digit", timeZone });
    const day = formatDate(date, locale, { day: "numeric", month: "short", timeZone: axisZone });
    const year = yearOf(date);
    return year === latestYear ? day : day + "\n" + year;
  };
  const horizontalAxis = timeline
    ? timelineAxis(timeline, formatAxisDate)
    : {
        type: "time" as const,
        minInterval: intraday ? 60000 : 86400000,
        boundaryGap: [0, 0] as [number, number],
        axisLabel: { formatter: formatAxisDate },
      };
  const observations = new Map<number, number>();
  (timeline?.rowIndexes ?? dates.map((_, index) => index)).forEach((row, position) => {
    if (row != null && lines.some((line) => line.values[row] != null)) observations.set(timeline ? position : Date.parse(dates[row]), row);
  });
  const positions = [...observations.keys()];
  const granularity: ReadingGranularity = intraday ? (multipleDays ? "intraday" : "clock") : "day";
  // Returns and drawdowns, and pound results, carry a sign and tone; other levels stay in ink.
  const figure = (value: number | null): Pick<ReadingItem, "value" | "tone"> =>
    percentage ? { value: signedPercent(value), tone: readingTone((value ?? 0) * 100) }
      : currencyTick ? { value: signedPounds(value), tone: readingTone(value) }
      : { value: fixed(value, 2) };
  const key = (line: ChartLine, index: number): ReadingKey => ({
    colour: historyLineColour(colours, line, index),
    ...(line.dashed ? { dashed: true } : {}),
    ...(line.type === "bar" ? { kind: "bar" as const } : {}),
  });
  const read = (position: number): Reading | null => {
    const row = observations.get(position);
    if (row == null) return null;
    const marks = new Set(lines.flatMap((line) => line.markers?.filter((mark) => mark.date === dates[row]).map((mark) => mark.name) ?? []));
    const time = [formatReadingTime(dates[row], locale, intraday ? timeZone : "UTC", granularity), ...marks].join(" · ");
    const [first, ...rest] = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.values[row] != null);
    if (!first) return { time };
    const item = ({ line, index }: typeof first): ReadingItem => ({ label: line.name, key: key(line, index), ...figure(line.values[row]) });
    // One line needs no label: the panel title already names it.
    return { time, primary: lines.length === 1 ? figure(first.line.values[row]) : item(first), ...(rest.length ? { groups: [rest.map(item)] } : {}) };
  };
  const latest = read(positions.at(-1)!);
  const readout: ChartReadout = {
    positions,
    latest: [latest?.primary?.label, latest?.primary?.value].filter(Boolean).join(" "),
    records: fullscreen ? (position) => {
      const row = observations.get(position)!;
      return lines.flatMap((line) => line.values[row] == null ? [] : [{
        time: dates[row], zone: intraday ? timeZone : "UTC", currency: percentage ? "%" : currencyTick ? "GBP" : "",
        basis: percentage ? "fractional return" : "level", source: notes?.[row] ?? label, series: line.name, value: line.values[row]!,
      }]);
    } : undefined,
    read,
    marks: (position) => {
      const row = observations.get(position);
      return row == null ? [] : lines.flatMap((line, index) => line.values[row] == null || line.type === "bar" ? []
        : [{ value: line.values[row]!, colour: historyLineColour(colours, line, index) }]);
    },
  };
  return (
    <>
      <Plot
        label={label}
        readout={readout}
        fullscreen={fullscreen}
        onBrush={onBrush && ((start,end) => {
          const a=observations.get(start), b=observations.get(end);
          if (a!=null && b!=null) onBrush(dates[a], dates[b]);
        })}
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
                  : currencyTick
                    ? (v < 0 ? "−£" : "£") +
                      Math.abs(v).toLocaleString("en-GB", {
                        notation: "compact",
                        maximumSignificantDigits: 5,
                      })
                  : Math.abs(v) < 10000
                    ? number(v, 2)
                    : compact(v),
            },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          series: lines.flatMap((line, i) => {
            const colour = historyLineColour(c, line, i);
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
              markPoint: line.markers?.length ? {
                silent: true, symbol: "circle", symbolSize: 7,
                label: { show: false },
                itemStyle: { color: colour, borderColor: c.tooltip, borderWidth: 1.5 },
                data: line.markers.flatMap(({ date, name }) => {
                  const row = dates.indexOf(date);
                  const x = timeline ? timeline.rowIndexes.indexOf(row) : Date.parse(date);
                  return row < 0 || x < 0 || line.values[row] == null ? [] : [{ coord: [x, line.values[row]], name }];
                }),
              } : undefined,
              emphasis: { focus: "series" },
              barMaxWidth: 24,
            } satisfies SeriesOption;
            return [primary, ...(gaps.length ? [{
              id: `history-gap:${i}`, type: "line" as const, data: gaps,
              silent: true, tooltip: { show: false }, symbol: "none", showSymbol: false,
              connectNulls: false,
              lineStyle: { color: colour, width: 1.5, type: "dotted" as const, opacity: 0.65 },
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
  items: Array<{ label: string; colour?: string; dashed?: boolean; dotted?: boolean }>;
}) {
  return (
    <div className="mx-chart-legend">
      {items.map((item, i) => (
        <span key={item.label}>
          {item.dashed || item.dotted ? (
            <svg width="15" height="4" aria-hidden="true">
              <path d="M0 2h15" stroke={item.colour ?? `var(--mx-chart-${i})`} strokeWidth="2" strokeDasharray={item.dotted ? "1 4" : "4 3"} />
            </svg>
          ) : <i style={{ background: item.colour ?? `var(--mx-chart-${i})` }} />}
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
        // Each bar carries its own label; a tooltip would only repeat it.
        tooltip: { show: false },
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
