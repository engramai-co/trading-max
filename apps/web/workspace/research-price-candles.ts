import type { SeriesOption } from "echarts";
import type { ChartColours } from "@/ui/charts/palette";
import type { ResearchPriceSeries } from "@/lib/types";

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

export function priceBarReading(
  point: PriceBar,
  date: string,
  currency: string,
  labels: { open: string; high: string; low: string; close: string },
  format: (value: number | null) => string,
  candle: boolean,
) {
  return [
    date + " · " + currency,
    ...(candle ? [
      `${labels.open} ${format(point.open)}`,
      `${labels.high} ${format(point.high)}`,
      `${labels.low} ${format(point.low)}`,
    ] : []),
    `${labels.close} ${format(point.close)}`,
  ];
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
