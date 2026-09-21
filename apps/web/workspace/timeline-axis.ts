import type { CalendarTimeline } from "@/lib/portfolio/history";

/** Short views use the plotted slot positions, including the folded weekend.
 * Round the stride to whole hours and reserve room for the actual cutoff. */
export function shortTimelineTicks(categories: string[], maxLabels: number) {
  if (categories.length < 2) return categories.length ? [0] : [];
  const last = categories.length - 1;
  const interval = Date.parse(categories[1]) - Date.parse(categories[0]);
  const hourSlots = Number.isFinite(interval) && interval > 0
    ? Math.max(1, Math.round(3_600_000 / interval)) : 1;
  const count = Math.max(2, Math.floor(maxLabels));
  const stride = Math.max(1, Math.ceil(last / (count - 1) / hourSlots) * hourSlots);
  const ticks = Array.from({ length: Math.floor(last / stride) + 1 }, (_, i) => i * stride);
  if (ticks.at(-1) !== last) {
    // A short final stub should not force two nearly adjacent labels.
    if (ticks.length > 1 && last - ticks.at(-1)! < stride / 2) ticks.pop();
    ticks.push(last);
  }
  return ticks;
}

/** Numeric trading-time positions retain spacing and let ECharts snap across
 * display buckets. A category axis only matches within half a ten-minute slot,
 * which hides tooltips between downsampled observations. */
export function timelineAxis(timeline: CalendarTimeline, formatDay: (time: number) => string, maxLabels = 7) {
  const labels = timeline.categories.map((stamp) => formatDay(Date.parse(stamp)));
  const uniqueLabels = labels.flatMap((label, index) => index === 0 || label !== labels[index - 1] ? [index] : []);
  const clockLabels = labels.length > 0 && labels.every((label) => /^\d{1,2}:\d{2}$/.test(label));
  const ticks = clockLabels
    ? labels.flatMap((label, index) => (label.endsWith(":00") && Number(label.split(":")[0]) % 4 === 0) || index === labels.length - 1 ? [index] : [])
    : uniqueLabels.length <= maxLabels ? uniqueLabels : Array.from({ length: maxLabels }, (_, index) => uniqueLabels[Math.round(index * (uniqueLabels.length - 1) / (maxLabels - 1))]);
  return {
    type: "value" as const,
    min: 0,
    max: Math.max(1, timeline.categories.length - 1),
    minInterval: 1,
    boundaryGap: [0, 0] as [number, number],
    splitLine: { show: false },
    axisLabel: {
      customValues: ticks,
      formatter: (value: number) => labels[value] ?? "",
    },
  };
}
