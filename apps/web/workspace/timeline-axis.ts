import type { CalendarTimeline } from "./portfolio-history";

/** Numeric trading-time positions retain spacing and let ECharts snap across
 * display buckets. A category axis only matches within half a ten-minute slot,
 * which hides tooltips between downsampled observations. */
export function timelineAxis(timeline: CalendarTimeline, formatDay: (time: number) => string) {
  const labels = timeline.categories.map((stamp) => formatDay(Date.parse(stamp)));
  const uniqueLabels = labels.flatMap((label, index) => index === 0 || label !== labels[index - 1] ? [index] : []);
  const clockLabels = labels.length > 0 && labels.every((label) => /^\d{1,2}:\d{2}$/.test(label));
  const ticks = clockLabels
    ? labels.flatMap((label, index) => (label.endsWith(":00") && Number(label.split(":")[0]) % 4 === 0) || index === labels.length - 1 ? [index] : [])
    : uniqueLabels.length <= 7 ? uniqueLabels : Array.from({ length: 7 }, (_, index) => uniqueLabels[Math.round(index * (uniqueLabels.length - 1) / 6)]);
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
