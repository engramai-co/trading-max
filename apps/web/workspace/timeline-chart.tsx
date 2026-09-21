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
import type { HistorySelection } from "./prepared-history";
import { HistoryRecords } from "./history-records";

export function TimelineChart({
  dates,
  layers,
  label,
  timeline,
  intraday = false,
  details = [],
  observations,
  tooltip,
  recordSource,
}: {
  dates: string[];
  layers: TimelineLayer[];
  label: string;
  timeline?: CalendarTimeline;
  intraday?: boolean;
  details?: Array<{ label: string; values: Array<number | null>; percentage?: boolean }>;
  observations?: NavPoint[];
  tooltip?: TimelineTooltip;
  recordSource?: HistorySelection;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const dailyDates = new Set(dates.filter((date) => !date.includes("T")).map(Date.parse));
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
        height={layers.length === 1 ? 314 : layers.length === 3 ? 706 : 510}
        option={(colours) =>
          timelineOption(dates, layers, colours, (time) => {
            const zone = intraday ? timeZone : "UTC";
            if (intraday && historyDay(dates[0]) === historyDay(dates.at(-1)!)) {
              return formatDate(time, locale, { hour: "2-digit", minute: "2-digit", timeZone: zone });
            }
            return formatDate(time, locale, { day: "numeric", month: "short", timeZone: zone })
              + "\n" + formatDate(time, locale, { year: "numeric", timeZone: zone });
          },
            timeline, details, (time) => formatDate(time, locale, !dailyDates.has(time)
              ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }
              : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }),
            tooltip,
          )
        }
      />
      {recordSource ? <HistoryRecords key={JSON.stringify(recordSource)} selection={recordSource} label={label} /> : <details className="mx-chart-data">
        <summary>{intraday || observations?.some((point) => point.intraday) ? t("查看精确记录", "View exact observations") : t("查看同日精确数据", "View aligned exact values")}</summary>
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
      </details>}
    </>
  );
}
