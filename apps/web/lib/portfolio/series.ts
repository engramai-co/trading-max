import type { CalendarTimeline } from "@/lib/portfolio/history";

/** Only empty display buckets become gaps; all readings remain original observations. */
export function historySeries(
  dates: string[], values: Array<number | null>, intraday: boolean,
  timeline?: CalendarTimeline,
) {
  const single = values.filter((value) => value != null).length === 1;
  if (timeline) {
    const rows = timeline.rowIndexes;
    const selected = new Set<number>();
    const interval = Math.max(1, timeline.displayIntervalMinutes ?? 10) * 60_000;
    // Stable UTC bucket boundaries keep overlapping ranges aligned, including
    // a six-month window that crosses a daylight-saving transition.
    const bucketAt = (index: number) => Math.floor(Date.parse(timeline.categories[index]) / interval);
    const valueAt = (index: number) => rows[index] == null ? null : values[rows[index]!];
    const buckets: Array<{ start: number; end: number; first: number; last: number }> = [];
    // First reduce to the display cadence. A missed ten-minute observation
    // cannot break an otherwise populated hourly or four-hour display bucket.
    for (let start = 0; start < rows.length;) {
      let end = start + 1;
      while (end < rows.length && bucketAt(end) === bucketAt(start)) end++;
      let first = -1, last = -1;
      for (let index = start; index < end; index++) {
        if (valueAt(index) == null) continue;
        if (first < 0) first = index;
        last = index;
        if (timeline.anchors?.[index]) selected.add(index);
      }
      buckets.push({ start, end, first, last });
      start = end;
    }
    for (let index = 0; index < buckets.length;) {
      const bucket = buckets[index];
      if (bucket.first < 0) {
        const gapStart = index;
        while (index < buckets.length && buckets[index].first < 0) index++;
        const before = buckets[gapStart - 1]?.last;
        const after = buckets[index]?.first;
        // Adjacent daily fallback observations are genuinely daily, not 143
        // missing ten-minute samples. Folded weekends still occupy one step.
        if (before != null && after != null
          && timeline.categories[before].includes("T")
          && !dates[rows[before]!].includes("T") && !dates[rows[after]!].includes("T")
          && after - before <= 144) continue;
        selected.add(buckets[gapStart].start);
        // Keep both ends of an unobserved span. Numeric-axis hover must find a
        // null boundary in the gap instead of snapping to a distant valid value.
        selected.add(buckets[index - 1].end - 1);
        continue;
      }
      // Preserve the first reading after a genuine display gap, then the last
      // reading in every populated bucket. Never average or interpolate values.
      if (index === 0 || buckets[index - 1].first < 0) selected.add(bucket.first);
      selected.add(bucket.last);
      index++;
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
