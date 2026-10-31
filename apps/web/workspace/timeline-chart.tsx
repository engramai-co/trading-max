"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Plot } from "./charts";
import { currency, percent } from "@/workspace/data";
import { EvidenceTable } from "./evidence-table";
import { Empty, useCopy } from "./foundation";
import { timelineOption, type TimelineLayer } from "./timeline-option";
import { timelineContext } from "./timeline-labels";
import type { TimelineTooltip } from "./timeline-tooltip";
import { valuationNote, type CalendarTimeline } from "@/lib/portfolio/history";
import type { NavPoint } from "@/lib/types";
import type { HistorySelection } from "@/lib/portfolio/prepared";
import { HistoryRecords } from "./history-records";
import type { Range } from "@/lib/portfolio/nav";

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
  range,
  pendingCashFlows = false,
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
  range?: Range;
  pendingCashFlows?: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const shortRange = range === "1D" || range === "1W";
  const display = shortRange ? { locale, timeZone, intraday, clock: intraday && range === "1D" } : undefined;
  const context = display && timeline ? timelineContext(timeline.categories, display) : "";
  const dailyDates = new Set(dates.filter((date) => !date.includes("T")).map(Date.parse));
  // Line styles explain themselves through a key, shown only when they occur.
  const rows = timeline?.rowIndexes ?? [];
  const firstRow = rows.findIndex((row) => row != null);
  const lastRow = rows.length - 1 - [...rows].reverse().findIndex((row) => row != null);
  const sourceKeys = observations ? [
    observations.some((point) => point.valuationSource === "reconstructed") && { dash: "4 3", label: t("重建估算", "Estimate") },
    firstRow >= 0 && rows.slice(firstRow, lastRow + 1).some((row) => row == null) && { dash: "1 4", label: t("缺失", "Missing") },
  ].filter((key): key is { dash: string; label: string } => Boolean(key)) : [];
  if (
    !dates.length ||
    (timeline && !timeline.rowIndexes.some((row) => row != null)) ||
    !layers.some((layer) =>
      layer.lines.some((line) => line.values.some((v) => v != null)),
    )
  ) {
    return (
      <>
        <Empty
          title={pendingCashFlows && dates.length
            ? t("估值已记录，净盈亏待核对", "Valuations recorded; P&L awaits reconciliation")
            : t("还没有可展示的观测记录", "No observations to chart yet")}
          description={pendingCashFlows && dates.length
            ? t("账户资金流水核对完成后，将恢复本区间的净盈亏曲线。已有记录仍可在下方查看。", "The P&L chart will return after account cash flows are reconciled. Recorded values remain available below.")
            : undefined}
        />
        {recordSource && dates.length > 0 && <HistoryRecords selection={recordSource} label={label} />}
      </>
    );
  }
  return (
    <>
      <Plot
        label={label}
        height={(layers.length === 1 ? 314 : layers.length === 3 ? 706 : 510) - (shortRange ? 24 : 0)}
        option={(colours) =>
          timelineOption(dates, layers, colours, (time) => {
            const zone = intraday ? timeZone : "UTC";
            // One line per date; the year appears only on dates outside the
            // latest year shown, so it marks the boundary instead of repeating.
            const day = formatDate(time, locale, { day: "numeric", month: "short", timeZone: zone });
            const year = formatDate(time, locale, { year: "numeric", timeZone: zone });
            return year === formatDate(Date.parse(dates.at(-1)!), locale, { year: "numeric", timeZone: zone })
              ? day
              : day + "\n" + year;
          },
            timeline, details, (time) => formatDate(time, locale, !dailyDates.has(time)
              ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }
              : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }),
            tooltip,
            display,
            observations?.map((point) => ({ estimated: point.valuationSource === "reconstructed", note: valuationNote(point, t) })),
          )
        }
      />
      {context && <p className="mx-timeline-context">{context}</p>}
      {sourceKeys.length > 0 && (
        <div className="mx-chart-legend mx-source-legend">
          {[{ dash: "", label: t("记录", "Recorded") }, ...sourceKeys].map((key) => (
            <span key={key.label}>
              <svg width="18" height="4" aria-hidden="true">
                <line x1="1" y1="2" x2="17" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={key.dash || undefined} />
              </svg>
              {key.label}
            </span>
          ))}
        </div>
      )}
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
