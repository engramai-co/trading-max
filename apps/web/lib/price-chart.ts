import type { PriceSeriesPoint } from "@/lib/types";

export const PRICE_CHART_RANGES = [
  { key: "1m", sessions: 21 },
  { key: "3m", sessions: 63 },
  { key: "6m", sessions: 126 },
  { key: "1y", sessions: 252 },
  { key: "2y", sessions: 504 },
  { key: "max", sessions: Number.POSITIVE_INFINITY },
] as const;

export type PriceChartRange = (typeof PRICE_CHART_RANGES)[number]["key"];

export type PriceChartWindow = {
  endIndex: number;
  endValue: string;
  startIndex: number;
  startValue: string;
};

export function priceChartWindow(
  points: ReadonlyArray<Pick<PriceSeriesPoint, "date">>,
  range: PriceChartRange,
): PriceChartWindow | null {
  if (points.length < 2) return null;
  const sessions = PRICE_CHART_RANGES.find((item) => item.key === range)?.sessions
    ?? 252;
  const windowSize = Number.isFinite(sessions)
    ? Math.min(sessions, points.length)
    : points.length;
  const startIndex = Math.max(points.length - windowSize, 0);
  const endIndex = points.length - 1;
  return {
    endIndex,
    endValue: points[endIndex].date,
    startIndex,
    startValue: points[startIndex].date,
  };
}
