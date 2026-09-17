import type { CalendarTimeline } from "./portfolio-history";

/** Plot real endpoints across short collection gaps; never synthesize observations. */
export function historySeries(
  dates: string[], values: Array<number | null>, intraday: boolean,
  timeline?: CalendarTimeline,
) {
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
        // Only an absent sample may be bridged, not an observed point whose
        // financial value is unknown. Retain calendar gaps for coverage and
        // hover; the line simply connects the two real endpoints.
        const bridge = valueAt(gapStart - 1) != null && valueAt(start) != null
          && rows.slice(gapStart, start).every((row) => row == null)
          && Date.parse(timeline.categories[start]) - Date.parse(timeline.categories[gapStart - 1])
            <= (timeline.maxConnectedGapMinutes ?? 0) * 60_000;
        if (bridge) continue;
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
        symbolSize: row != null && (rows.length < 8 || (valueAt(index - 1) == null && valueAt(index + 1) == null)) ? 6 : 0,
      };
    });
  }
  const limit = intraday ? 30 * 60_000 : 4 * 86_400_000;
  const times = dates.map((date) => Date.parse(date));
  return times.flatMap((time, index) => {
    const before = index > 0 && time - times[index - 1] <= limit && values[index - 1] != null;
    const after = index + 1 < times.length && times[index + 1] - time <= limit && values[index + 1] != null;
    return [
      ...(index > 0 && time - times[index - 1] > limit
        ? [{ value: [time - 1, null], symbolSize: 0 }] : []),
      { value: [time, values[index]], symbolSize: dates.length < 8 || (!before && !after) ? 6 : 0 },
    ];
  });
}
