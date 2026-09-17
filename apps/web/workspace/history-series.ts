import type { CalendarTimeline } from "./portfolio-history";

/** Keep missing observations explicit; a separate dashed series connects their endpoints. */
export function historySeries(
  dates: string[], values: Array<number | null>, intraday: boolean,
  timeline?: CalendarTimeline,
) {
  const single = values.filter((value) => value != null).length === 1;
  if (timeline) {
    const rows = timeline.rowIndexes;
    const selected = new Set<number>();
    const interval = Math.max(1, timeline.displayIntervalMinutes ?? 10) * 60_000;
    const origin = Date.parse(timeline.categories[0]);
    const bucketAt = (index: number) => Math.floor((Date.parse(timeline.categories[index]) - origin) / interval);
    const valueAt = (index: number) => rows[index] == null ? null : values[rows[index]!];
    // Select the last real observation in each fixed time bucket. Keep segment
    // endpoints and source anchors without treating source changes as gaps.
    for (let start = 0; start < rows.length;) {
      if (valueAt(start) == null) {
        const gapStart = start;
        while (start < rows.length && valueAt(start) == null) start++;
        selected.add(gapStart);
        // Keep both ends of an unobserved span. Numeric-axis hover must find a
        // null boundary in the gap instead of snapping to a distant valid value.
        selected.add(start - 1);
        continue;
      }
      let end = start + 1;
      while (end < rows.length && valueAt(end) != null) end++;
      selected.add(start);
      for (let index = start; index < end; index++) {
        if (timeline.anchors?.[index] || index === end - 1 || bucketAt(index) !== bucketAt(index + 1)) selected.add(index);
      }
      start = end;
    }
    return [...selected].sort((a, b) => a - b).map((index) => {
      const row = rows[index];
      return {
        value: [index, row == null ? null : values[row]],
        symbolSize: row != null && single ? 4 : 0,
      };
    });
  }
  const limit = intraday ? 30 * 60_000 : 4 * 86_400_000;
  const times = dates.map((date) => Date.parse(date));
  return times.flatMap((time, index) => {
    return [
      ...(index > 0 && time - times[index - 1] > limit
        ? [{ value: [time - 1, null], symbolSize: 0 }] : []),
      { value: [time, values[index]], symbolSize: single ? 4 : 0 },
    ];
  });
}

/** Visual connectors contain endpoints only, never estimated readings or filled areas. */
export function historyGapSeries(series: ReturnType<typeof historySeries>) {
  const gaps: Array<[number, number | null]> = [];
  let previous: [number, number] | null = null;
  let missing = false;
  for (const point of series) {
    const [position, value] = point.value;
    if (value == null) { missing = true; continue; }
    if (previous && missing) gaps.push(previous, [position!, value], [position!, null]);
    previous = [position!, value];
    missing = false;
  }
  return gaps;
}
