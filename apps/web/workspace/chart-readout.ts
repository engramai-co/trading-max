import type { ChartRecord } from "./chart-export";

/** Coordinates in the chart's first x axis, in ascending order. The value
 * reader uses these same coordinates; a drawn connector is never a point. */
export type ChartReadout = {
  positions: readonly number[];
  point: (position: number) => string;
  /** Provenance shown under the values, apart from them. */
  note?: (position: number) => string | undefined;
  latest: string;
  /** Return no reading for a known missing interval, even near its ends. */
  gap?: (position: number) => boolean;
  observationCount?: number;
  gridIndexes?: readonly number[];
  records?: (position: number) => ChartRecord[];
};

export type ReadingRow = { label: string; value: string } | { text: string };

/** A multi-line reading names its point first; "label: value" lines align as rows. */
export function readingRows(reading: string): { heading: string; rows: ReadingRow[] } {
  const lines = reading.split("\n").filter(Boolean);
  if (lines.length < 2) return { heading: "", rows: lines.map((text) => ({ text })) };
  const [heading, ...rest] = lines;
  return {
    heading,
    rows: rest.map((line) => {
      const at = line.indexOf(": ");
      return at > 0 ? { label: line.slice(0, at), value: line.slice(at + 2) } : { text: line };
    }),
  };
}

export function closestChartPosition(positions: readonly number[], target: number) {
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && (lo === positions.length || target - positions[lo - 1] < positions[lo] - target)) return lo - 1;
  return lo < positions.length ? lo : -1;
}
