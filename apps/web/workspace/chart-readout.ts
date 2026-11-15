/** Coordinates in the chart's first x axis, in ascending order. The value
 * reader uses these same coordinates; a drawn connector is never a point. */
export type ChartReadout = {
  positions: readonly number[];
  point: (position: number) => string;
  latest: string;
  /** Return no reading for a known missing interval, even near its ends. */
  gap?: (position: number) => boolean;
  observationCount?: number;
};

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
