import type { SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { CalendarTimeline } from "@/lib/portfolio/history";
import type { ChartReadout, Reading, ReadingItem, ReadingKey, ReadingMark } from "./chart-readout";
import { readingTone, signedPercent, signedPounds, pounds } from "./reading-format";
import { timelineLineColour, type TimelineLayer } from "./timeline-option";

export type TimelineFigures = Pick<Reading, "primary" | "groups" | "more">;
export type TimelineReadingContext = {
  /** The pane being read; absent for keyboard readings. */
  grid?: number;
  /** The stroke of a layer's line, for the row that names it. */
  key: (layer: number, line?: number) => ReadingKey;
};
/** A surface's own figures for one observation row; the chart supplies its time, exception word and dots. */
export type TimelineReading = (row: number, context: TimelineReadingContext) => TimelineFigures;

/** Chart position → observation row for every position with a plotted value; gap markers have none. */
export function timelineRows(dates: string[], layers: TimelineLayer[], calendar?: CalendarTimeline) {
  const rows = new Map<number, number>();
  const hasValues = (row: number) => layers.some((layer) => layer.lines.some((line) => line.values[row] != null));
  (calendar?.rowIndexes ?? dates.map((_, i) => i)).forEach((row, position) => {
    if (row != null && hasValues(row)) rows.set(calendar ? position : Date.parse(dates[row]), row);
  });
  return rows;
}

/** The [start, end] positions each dotted gap connector crosses, read from the chart's own gap series. */
export function timelineGaps(series: SeriesOption[]) {
  return series.flatMap((item) => {
    if (item.id !== "history-gap:0:0" || !("data" in item) || !Array.isArray(item.data)) return [];
    return item.data.flatMap((point, index, all) => {
      if (index % 3 !== 0 || !Array.isArray(point) || !Array.isArray(all[index + 1])) return [];
      return [[Number(point[0]), Number((all[index + 1] as number[])[0])] as const];
    });
  });
}

/** A pound or percentage figure; P&L, drawdown and return layers carry a sign and tone, levels do not. */
export function timelineItem(layer: TimelineLayer, value: number | null | undefined) {
  const signed = layer.zeroBaseline || layer.drawdown || layer.percentage;
  if (!signed) return { value: pounds(value) };
  return { value: layer.percentage ? signedPercent(value) : signedPounds(value), tone: readingTone(layer.percentage ? (value ?? 0) * 100 : value) };
}

/** Every plotted line at the row: one line has no label; with several, the first leads and each row keys its line. */
export function defaultTimelineFigures(layers: TimelineLayer[]): TimelineReading {
  return (row, { key }) => {
    const entries = layers.flatMap((layer, l) => layer.lines.map((line, i) => ({ layer, l, line, i })));
    const shown = entries.filter(({ line }) => line.values[row] != null);
    const [first, ...rest] = shown;
    if (!first) return {};
    const item = (entry: typeof first): ReadingItem => ({
      label: entry.line.name, key: key(entry.l, entry.i), ...timelineItem(entry.layer, entry.line.values[row]),
    });
    return {
      primary: entries.length === 1 ? timelineItem(first.layer, first.line.values[row]) : item(first),
      groups: rest.length ? [rest.map(item)] : undefined,
    };
  };
}

export function timelineReadout({
  rows,
  layers,
  colours,
  time,
  flag,
  reading,
  gap,
  records,
}: {
  /** Chart position → observation row, in ascending position order. */
  rows: Map<number, number>;
  layers: TimelineLayer[];
  colours: ChartColours;
  /** The reading's time for a row, with any marker name. */
  time: (row: number) => string;
  /** One exception word for a row, if its basis differs from the panel's. */
  flag?: (row: number, position: number) => string | undefined;
  reading?: TimelineReading;
  /** A known missing interval, where the chart shows no reading. */
  gap?: (position: number) => boolean;
  records?: ChartReadout["records"];
}): ChartReadout {
  const positions = [...rows.keys()];
  const key = (layer: number, line = 0): ReadingKey => {
    const item = layers[layer]?.lines[line];
    return { colour: timelineLineColour(colours, layer, line, item ?? {}), ...(item?.dashed ? { dashed: true } : {}) };
  };
  const figures = reading ?? defaultTimelineFigures(layers);
  const read = (position: number, grid?: number): Reading | null => {
    const row = rows.get(position);
    if (row == null) return null;
    const exception = flag?.(row, position);
    return { time: time(row), ...(exception ? { flag: exception } : {}), ...figures(row, { grid, key }) };
  };
  const latest = positions.length ? read(positions.at(-1)!) : null;
  return {
    positions,
    latest: [latest?.primary?.label, latest?.primary?.value].filter(Boolean).join(" "),
    read: (position, context) => read(position, context?.grid),
    marks: (position) => {
      const row = rows.get(position);
      if (row == null) return [];
      return layers.flatMap((layer, l) => layer.lines.flatMap((line, i): ReadingMark[] => {
        const value = line.values[row];
        return value == null ? [] : [{ value, colour: key(l, i).colour, xAxisIndex: l, yAxisIndex: l }];
      }));
    },
    ...(gap ? { gap } : {}),
    ...(records ? { records } : {}),
  };
}

