import type { SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { ResearchPriceSeries } from "@/lib/types";
import type { Reading, ReadingItem } from "./chart-readout";
import { fixed, readingTone, signedNumber, signedPercent } from "./reading-format";

export type PriceBar = ResearchPriceSeries["points"][number];

/** ECharts expects open, close, low, high. A missing leg must not create a
 * candle or downgrade the entire period if usable OHLC exists elsewhere. */
export function candleValues(points: readonly PriceBar[]) {
  return points.map(({ open, close, low, high }) =>
    open != null && high != null && low != null
      && [open, close, low, high].every(Number.isFinite)
      && low <= Math.min(open, close) && high >= Math.max(open, close)
      ? [open, close, low, high] : [null, null, null, null]);
}

export function candleSeries(name: string, data: ReturnType<typeof candleValues>, c: ChartColours): SeriesOption {
  return {
    type: "candlestick",
    name,
    data,
    itemStyle: { color: c.positive, color0: c.negative, borderColor: c.positive, borderColor0: c.negative },
  };
}

/** Each bar's reference close: the bar before on daily charts, the previous session's last bar intraday. */
export function previousCloses(points: readonly PriceBar[], intraday: boolean, session: (date: string) => string) {
  let day = "", last: number | null = null, reference: number | null = null;
  return points.map((point, index) => {
    if (!intraday) return index > 0 ? points[index - 1].close ?? null : null;
    const current = session(point.date);
    if (current !== day) {
      reference = last;
      day = current;
    }
    if (Number.isFinite(point.close)) last = point.close;
    return reference;
  });
}

/** The move from the reference close, "+3.53 · +1.05%", with its tone. */
export function priceChange(close: number | null | undefined, previous: number | null | undefined, digits = 2) {
  if (close == null || previous == null || !Number.isFinite(close) || !Number.isFinite(previous) || previous === 0) return null;
  const move = close - previous;
  return { value: signedNumber(move, digits) + " · " + signedPercent(move / previous), tone: readingTone(move, digits) };
}

/**
 * A price bar as a reading: the close leads in ink, followed by its move from the reference
 * close in gain or loss colour; open, high, low and volume form a 2×2 grid. Without a whole
 * candle the close leads alone and the move takes a row. The panel names the currency once.
 */
export function priceReading({ bar, previous, time, candle, volume, labels, digits = 2, indicators = [] }: {
  bar: PriceBar;
  previous?: number | null;
  time: string;
  candle: boolean;
  /** Volume in the volume axis's units. */
  volume?: string;
  labels: { change: string; volume: string };
  digits?: number;
  /** Indicator cells after the prices, in the order they should survive the card's limit. */
  indicators?: ReadingItem[];
}): Reading {
  const price = (value: number | null | undefined) => fixed(value, digits);
  const change = priceChange(bar.close, previous, digits);
  const groups = indicators.length ? [indicators] : [];
  if (candle && bar.open != null && bar.high != null && bar.low != null) {
    return {
      time,
      ohlc: {
        close: price(bar.close),
        ...(change ? { change: change.value, ...(change.tone ? { tone: change.tone } : {}) } : {}),
        open: price(bar.open), high: price(bar.high), low: price(bar.low),
        ...(volume ? { volume } : {}),
      },
      ...(groups.length ? { groups } : {}),
    };
  }
  const moves: ReadingItem[] = [
    ...(change ? [{ label: labels.change, value: change.value, ...(change.tone ? { tone: change.tone } : {}) }] : []),
    ...(volume ? [{ label: labels.volume, value: volume }] : []),
  ];
  return { time, primary: { value: price(bar.close) }, ...(moves.length || groups.length ? { groups: [moves, ...groups].filter((group) => group.length) } : {}) };
}

/** A missing sample inside one regular session is different from an overnight,
 * weekend or holiday closure. Date-only feeds need a provider calendar before
 * a missing calendar date can be classified as a missing observation. */
export function priceSlots(points: readonly PriceBar[], interval: string, localDay: (date: string) => string) {
  const minutes = /^([1-9][0-9]*)m$/.exec(interval);
  const expected = minutes ? Number(minutes[1]) * 60_000 : 0;
  return points.flatMap((point, index): Array<{ date: string; bar: PriceBar | null; index: number }> => {
    const item = { date: point.date, bar: point, index };
    if (!expected || index === 0) return [item];
    const previous = points[index - 1];
    const start = Date.parse(previous.date), end = Date.parse(point.date);
    const gap = end - start > expected && localDay(previous.date) === localDay(point.date);
    return gap ? [{ date: new Date(start + expected).toISOString(), bar: null, index: -1 }, item] : [item];
  });
}

export function priceGapConnectors(slots: readonly (number | null)[]) {
  const data: Array<[number, number | null]> = [];
  let last = -1;
  slots.forEach((value, index) => {
    if (value == null) return;
    if (last >= 0 && index - last > 1) data.push([last, slots[last]], [index, value], [index, null]);
    last = index;
  });
  return data;
}
