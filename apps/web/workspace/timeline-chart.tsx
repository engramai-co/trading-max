"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Plot } from "./charts";
import { currency, percent } from "./data";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { timelineOption, type TimelineLayer } from "./timeline-option";
import type { TimelineTooltip } from "./timeline-tooltip";
import { historyDay, valuationNote, type CalendarTimeline } from "./portfolio-history";
import type { NavPoint } from "@/lib/types";

export function TimelineChart({
  dates,
  layers,
  label,
  timeline,
  intraday = false,
  details = [],
  observations,
  tooltip,
}: {
  dates: string[];
  layers: TimelineLayer[];
  label: string;
  timeline?: CalendarTimeline;
  intraday?: boolean;
  details?: Array<{ label: string; values: Array<number | null>; percentage?: boolean }>;
  observations?: NavPoint[];
  tooltip?: TimelineTooltip;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (
    !dates.length ||
    (timeline && !timeline.rowIndexes.some((row) => row != null)) ||
    !layers.some((layer) =>
      layer.lines.some((line) => line.values.some((v) => v != null)),
    )
  ) {
    return (
      <Empty
        title={t("还没有可展示的观测记录", "No observations to chart yet")}
      />
    );
  }
  return (
    <>
      <Plot
        label={label}
        height={layers.length === 3 ? 586 : 434}
        option={(colours) =>
          timelineOption(dates, layers, colours, (time) =>
            formatDate(time, locale, {
              ...(intraday && historyDay(dates[0]) === historyDay(dates.at(-1)!)
                ? { hour: "2-digit", minute: "2-digit" }
                : { day: "numeric", month: "short" }),
              timeZone: intraday ? timeZone : "UTC",
            }),
            timeline, details, (time) => formatDate(time, locale, intraday
              ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }
              : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }),
            tooltip,
          )
        }
      />
      <details className="mx-chart-data">
        <summary>{intraday ? t("查看精确记录", "View exact observations") : t("查看同日精确数据", "View aligned exact values")}</summary>
        <EvidenceTable
          label={label}
          rows={dates.map((date, index) => ({ date, index }))}
          columns={[
            { label: t("日期", "Date"), value: (row) => row.date },
            ...(observations ? [{ label: t("来源与精度", "Source & precision"), value: (row: { index: number }) => valuationNote(observations[row.index], t) }] : []),
            ...layers.flatMap((layer) =>
              layer.lines.map((line) => ({
                label: `${layer.label} · ${line.name}`,
                numeric: true,
                value: (row: { index: number }) =>
                  layer.percentage
                    ? percent(line.values[row.index], false, 2)
                    : currency(line.values[row.index], "GBP", 2),
              })),
            ),
            ...details.map((detail) => ({
              label: detail.label,
              numeric: true,
              value: (row: { index: number }) => detail.percentage
                ? percent(detail.values[row.index], false, 2) : currency(detail.values[row.index], "GBP", 2),
            })),
          ]}
        />
      </details>
    </>
  );
}
