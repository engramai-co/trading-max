"use client";
import { quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatEventTime } from "@/ui/formatters";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Group, Select, TextInput } from "@mantine/core";
import { useState, type ReactNode } from "react";
import {
  nextEarningsDate,
  estimateChange90,
  normalizeRatingRow,
  ratingKeys,
  recommendationChange,
  revisionAxis,
  targetAmount,
  targetUnitScale,
} from "./analyst-data";
import { analystSections, DeferredPlot, ResearchReading } from "./research-reading";
import { useChartColours } from "@/ui/charts/palette";
import { readingText, type Reading } from "./chart-readout";
import { fixed, readingTone, signedNumber, signedPercent, telling } from "./reading-format";
import { DataBasis } from "./reading-card";
import { number, object, objects, percent, safeUrl, str } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Empty, Panel, TextLink, useCopy } from "./foundation";
import { ratingLabel } from "./market-terms";
import { filingTitle } from "./research-filings";
import { AnalystExpectations } from "./research-expectations";
import { AnalystEstimates, forecastPeriodLabel } from "./research-forecasts";
import type { ResearchPrice } from "./research-price-basis";
import { useRouteState } from "./route-state";

export function AnalystView({
  data,
  revision,
  price,
  earningsBrief,
}: {
  data: ResearchLensSnapshot;
  revision?: string | null;
  price?: ResearchPrice;
  earningsBrief?: ReactNode;
}) {
  const t = useCopy();
  return <ResearchReading sections={analystSections} parameter="analystView" before={earningsBrief}>
    <section id="research-ratings">
      <h2>{t("评级与目标价", "Ratings & targets")}</h2>
      {data.analyst ? <AnalystExpectations data={data} revision={revision} price={price} />
        : <Panel><Empty title={t("暂无分析师覆盖", "No analyst coverage")} /></Panel>}
      <RatingHistory data={data} />
    </section>
    <div id="research-forecast">
      <AnalystEstimates data={data} />
      <EpsTimeline data={data} />
      <EstimateRevisions data={data} />
    </div>
    <div id="research-events" data-reading-event=""><EarningsEvents data={data} /></div>
    <div id="research-actions"><InstitutionalActions data={data} /></div>
  </ResearchReading>;
}

/** Quarter ends read as month and year; estimates keep their marker. */
function quarterLabel(date: string, future: boolean, locale: "zh" | "en", estimate: string) {
  const month = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { year: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(date + "T00:00:00Z"));
  return future ? month + " " + estimate : month;
}

/**
 * A beat or miss as the EPS reading writes it: signed, to the places that tell the two EPS apart,
 * and coloured by its direction. With a share, the percentage of the estimate in the same colour.
 */
function Surprise({ gap, places, share }: { gap: number | null; places: number; share?: number | null }) {
  if (gap == null || share === null) return <>—</>;
  const direction = readingTone(gap, places);
  return <span className={direction && "mx-" + direction}>{share === undefined ? signedNumber(gap, places) : signedPercent(share)}</span>;
}

function EpsTimeline({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy(),
    { update } = useRouteState("push");
  const { locale } = useLocale();
  const a = object(data.analyst);
  const code = str(a.reportingCurrency) || data.financialFacts?.currency || "";
  const actual = objects(a.earningsHistory)
    .map((r) => ({
      date: str(r.quarter ?? r.index).slice(0, 10),
      actual: numeric(r.epsActual),
      estimate: numeric(r.epsEstimate),
      surprise: numeric(r.surprisePercent),
      future: false,
    }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const future = objects(a.earningsEstimate)
    .filter(
      (r) => str(r.period ?? r.index).endsWith("q") && str(r.currency) === code,
    )
    .map((r) => ({
      date: str(
        r.endDate ||
          objects(a.fiscalPeriods).find(
            (p) => p.period === (r.period ?? r.index),
          )?.endDate,
      ).slice(0, 10),
      actual: null,
      estimate: numeric(r.avg),
      surprise: null,
      future: true,
    }))
    .filter((r) => r.date && r.date > (actual.at(-1)?.date ?? ""));
  const rows = [...actual, ...future].filter((r) => r.actual != null || r.estimate != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const difference = (r: typeof rows[number]) => r.actual == null || r.estimate == null ? null : r.actual - r.estimate;
  // Three decimals only where a quarter's reported and estimated EPS differ in the third place.
  const digits = (r: typeof rows[number]) => telling([r.actual, r.estimate]);
  /** Reported EPS leads; the estimate and the toned surprise follow. The panel names the currency. */
  const readEps = (r: typeof rows[number]): Reading => {
    const places = digits(r);
    const gap = difference(r);
    const estimate = { label: t("预期", "Estimate"), value: fixed(r.estimate, places) };
    return {
      time: quarterLabel(r.date, false, locale, ""),
      ...(r.actual == null ? { primary: estimate } : {
        primary: { label: t("已公布", "Reported"), value: fixed(r.actual, places) },
        groups: [[
          ...(r.estimate == null ? [] : [estimate]),
          ...(gap == null ? [] : [{
            label: t("超预期", "Surprise"),
            value: signedNumber(gap, places) + (r.surprise == null ? "" : " · " + signedPercent(r.surprise)),
            tone: readingTone(gap, places),
          }]),
        ]],
      }),
    };
  };
  if (!rows.length) return null;
  return (
    <Panel
      title={t("季度每股收益", "Quarterly EPS")}
      help={<>
        <p>{t(
          "空心点代表预期；未来没有已公布值。超预期 = 已公布 − 预期，百分比相对预期。",
          "Hollow points are estimates; future periods have no reported value. Surprise is reported less estimated EPS, and its percentage is relative to the estimate.",
        )}</p>
        <DataBasis>{t(
          "已公布与预期均保留分析师数据源的 EPS 口径，可能经过调整，不与报表中的 GAAP EPS 混合；币种标在纵轴上。",
          "Reported and estimated EPS keep the analyst provider’s basis, which may be adjusted, and are not mixed with statement GAAP EPS. The value axis names the currency.",
        )}</DataBasis>
      </>}
    >
      {rows.length > 1 ? <DeferredPlot
        research
        height={220}
        label={t("季度 EPS 实际与预期", "Reported and estimated quarterly EPS")}
        readout={{
          positions: rows.map((_, i) => i),
          latest: (() => {
            const last = rows.findLast((r) => r.actual != null) ?? rows.at(-1)!;
            return fixed(last.actual ?? last.estimate, digits(last));
          })(),
          read: (index) => readEps(rows[index]),
        }}
        option={(c) => ({
          legend: { bottom: 0, textStyle: { color: c.text } },
          grid: { top: 20, left: 52, right: 20, bottom: 70 },
          xAxis: {
            type: "category",
            data: rows.map((r) => quarterLabel(r.date, r.future, locale, t("预期", "est."))),
            axisLabel: { color: c.axis, hideOverlap: true },
          },
          yAxis: {
            type: "value",
            name: code,
            scale: true,
            axisLabel: { color: c.axis },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          series: [
            {
              type: "scatter",
              name: t("已公布", "Reported"),
              data: rows.map((r) => r.actual),
              symbolSize: 10,
              itemStyle: { color: c.brand },
            },
            {
              type: "scatter",
              name: t("预期", "Estimate"),
              data: rows.map((r) => r.estimate),
              symbol: "emptyDiamond",
              symbolSize: 12,
              itemStyle: { color: c.axis },
            },
          ],
        })}
      /> : <div className="mx-chart-readout"><div className="mx-chart-readout-values">
        {readingText(readEps(rows[0]), locale).split("\n").map((line, i) => <span key={i}>{line}</span>)}
      </div></div>}
      <details className="mx-chart-data">
        <summary>{t("季度读数", "Quarterly readings")}</summary>
        <EvidenceTable
          label={t("季度 EPS 明细", "Quarterly EPS details")}
          rows={rows}
          columns={[
            {
              label: t("季度截至", "Quarter ending"),
              value: (r) => formatCalendarDate(r.date, locale) + (r.future ? t(" · 预期", " · est.") : ""),
            },
            {
              label: t("已公布", "Reported"),
              value: (r) => number(r.actual, 2),
              numeric: true,
            },
            {
              label: t("预期", "Estimate"),
              value: (r) => number(r.estimate, 2),
              numeric: true,
            },
            {
              label: t("超预期", "Surprise"),
              value: (r) => <Surprise gap={difference(r)} places={digits(r)} />,
              numeric: true,
            },
            {
              label: t("超预期幅度", "Surprise %"),
              value: (r) => <Surprise gap={difference(r)} places={digits(r)} share={r.surprise} />,
              numeric: true,
            },
            {
              label: t("财报", "Statement"),
              value: (r) =>
                !r.future &&
                data.financialFacts?.periods.some(
                  (p) =>
                    p.kind === "quarterly" &&
                    (p.providerEnd === r.date || p.actualEnd === r.date),
                ) ? (
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    onClick={() => {
                      const p = data.financialFacts?.periods.find(
                        (p) =>
                          p.kind === "quarterly" &&
                          (p.providerEnd === r.date || p.actualEnd === r.date),
                      );
                      update({
                        view: "fundamentals",
                        frequency: "quarterly",
                        period: p?.id ?? null,
                        fact: p ? "eps" : null,
                        eventPeriod: r.date,
                      });
                    }}
                  >
                    {t("查看", "Open")}
                  </Button>
                ) : r.future ? (
                  "—"
                ) : (
                  t("该期暂无报表", "Statement unavailable")
                ),
            },
          ]}
        />
      </details>
    </Panel>
  );
}

function EstimateRevisions({ data }: { data: ResearchLensSnapshot }) {
  const { locale } = useLocale();
  const colours = useChartColours();
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const a = object(data.analyst),
    trend = objects(a.epsTrend),
    revisions = objects(a.epsRevisions);
  if (!trend.length) return null;
  const key = (r: Record<string, unknown>) => str(r.index ?? r.period);
  const selected =
    trend.find((r) => key(r) === (params.get("forecastPeriod") ?? "0q")) ?? trend[0];
  const code =
    str(
      objects(a.earningsEstimate).find((r) => key(r) === key(selected))
        ?.currency,
    ) || str(a.reportingCurrency);
  const days = ["90daysAgo", "60daysAgo", "30daysAgo", "7daysAgo", "current"];
  const labels = [
    t("90 天前", "90 days ago"),
    t("60 天前", "60 days ago"),
    t("30 天前", "30 days ago"),
    t("7 天前", "7 days ago"),
    t("当前", "Current"),
  ];
  const r = revisions.find((r) => key(r) === key(selected));
  const values = days.map((d) => numeric(selected[d]));
  const axis = revisionAxis(values);
  const change90 = estimateChange90(selected);
  const direction90 = change90 == null ? undefined : readingTone(change90 * 100, 1);
  // Revisions are small: show the third decimal whenever it tells two readings apart.
  const places = telling(values);
  const readRevision = (index: number): Reading => {
    const previous = values.slice(0, index).findLast((value) => value != null);
    const change = values[index] == null || previous == null ? null : values[index]! - previous;
    return {
      time: labels[index],
      primary: { value: fixed(values[index], places) },
      ...(change == null || !readingTone(change, places) ? {} : {
        groups: [[{ label: t("较上一读数", "Since previous"), value: signedNumber(change, places), tone: readingTone(change, places) }]],
      }),
    };
  };
  const positions = values.flatMap((value, index) => value == null ? [] : [index]);
  return (
    <Panel
      title={t("盈利预期修订", "EPS estimate revisions")}
      action={
        <Select
          w={240}
          aria-label={t("修订对应的报告期", "Revision fiscal period")}
          value={key(selected)}
          onChange={(v) => update({ forecastPeriod: v }, { focusResearchSection: false })}
          data={trend.map((r) => ({
            value: key(r),
            label: forecastPeriodLabel(a, key(r), t),
          }))}
        />
      }
    >
      <DeferredPlot
        height={200}
        label={t(
          "同一财期的 EPS 预期修订",
          "EPS estimate revisions for one fiscal period",
        )}
        readout={positions.length ? {
          positions,
          latest: fixed(values[positions.at(-1)!], places),
          read: readRevision,
          marks: (index) => values[index] == null ? [] : [{ value: values[index]!, colour: colours.brand }],
        } : undefined}
        option={(c) => ({
          xAxis: {
            type: "category",
            data: labels,
            axisLabel: { color: c.axis },
            axisTick: { show: false },
          },
          yAxis: {
            type: "value",
            name: code,
            ...(axis ?? { scale: true }),
            axisLabel: { color: c.axis },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          series: [
            {
              type: "line",
              name: t("EPS 预期", "EPS estimate"),
              data: values,
              connectNulls: false,
              symbolSize: 6,
              lineStyle: { color: c.brand, width: 2 },
              itemStyle: { color: c.brand },
            },
          ],
        })}
      />
      <details className="mx-chart-data">
        <summary>{t("修订读数与口径", "Readings and basis")}</summary>
        <EvidenceTable
          label={t("预期修订读数", "Estimate revision readings")}
          rows={[selected]}
          columns={days.map((d, i) => ({
            label: labels[i],
            value: (row: Record<string, unknown>) => number(row[d], 2),
            numeric: true,
          }))}
        />
        <p>{t("90 天 EPS 预期变化", "90-day EPS estimate change")} <span className={direction90 && "mx-" + direction90}>{percent(change90, true)}</span></p>
        {r && (
          <p>
            {locale === "zh"
              ? `近 7 天上修 ${number(r.upLast7days, 0)} · 下修 ${number(r.downLast7Days ?? r.downLast7days, 0)}；近 30 天上修 ${number(r.upLast30days, 0)} · 下修 ${number(r.downLast30days, 0)}`
              : `7 days: ${number(r.upLast7days, 0)} up · ${number(r.downLast7Days ?? r.downLast7days, 0)} down; 30 days: ${number(r.upLast30days, 0)} up · ${number(r.downLast30days, 0)} down`}
          </p>
        )}
        <p>
          {forecastPeriodLabel(a, key(selected), t)} ·{" "}
          {formatCalendarDate(str(a.asOf), locale)} · Yahoo Finance
        </p>
      </details>
    </Panel>
  );
}

/** Each month's ratings as one compact bar, strong buy first; the counts sit in the table below. */
function RatingHistory({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const { locale } = useLocale();
  // The current month leads, then each month before it.
  const age = (v: unknown) => /^-?\d+m$/.test(str(v)) ? Math.abs(parseInt(str(v))) : Number.POSITIVE_INFINITY;
  const recommendations = objects(object(data.analyst).recommendations).map(normalizeRatingRow)
    .sort((a, b) => age(a.period) - age(b.period) || 0);
  const labels = [
    t("强烈买入", "Strong buy"),
    t("买入", "Buy"),
    t("持有", "Hold"),
    t("卖出", "Sell"),
    t("强烈卖出", "Strong sell"),
  ];
  const period = (v: unknown) => {
    if (str(v) === "0m") return t("当前", "Current");
    if (!/^-\d+m$/.test(str(v))) return str(v);
    const months = Math.abs(parseInt(str(v)));
    return months + (months === 1 ? t(" 个月前", " month ago") : t(" 个月前", " months ago"));
  };
  if (!recommendations.length) return null;
  return <details className="mx-chart-data mx-rating-history">
          <summary>{t("评级分布历史", "Historical rating distribution")}</summary>
          <ul className="mx-rating-history-rows" aria-label={t("各类评级的分析师数量", "Analyst counts by rating category")}>
            {recommendations.map((row, index) => {
              const counts = ratingKeys.map((key) => numeric(row[key]) ?? 0);
              const total = counts.reduce((sum, count) => sum + count, 0);
              // Every rating is read, zeros included; the bar draws only those with analysts.
              const spoken = counts.map((count, i) => labels[i] + " " + number(count, 0)).join(locale === "zh" ? "，" : ", ");
              return <li key={str(row.period) || index}>
                <span>{period(row.period)}</span>
                <span className="mx-rating-history-bar" role="img" aria-label={spoken}>
                  {counts.map((count, i) => count > 0 &&
                    <span key={ratingKeys[i]} style={{ flexGrow: count, background: `var(--mx-rating-${i})` }} />)}
                </span>
                <strong>{number(total, 0)}</strong>
              </li>;
            })}
          </ul>
          <ul className="mx-rating-history-key" aria-hidden="true">
            {labels.map((label, i) => <li key={label}><span style={{ background: `var(--mx-rating-${i})` }} />{label}</li>)}
          </ul>
          <details className="mx-chart-data">
            <summary>{t("评级数量", "Rating counts")}</summary>
            <EvidenceTable
              label={t("评级数量明细", "Rating count details")}
              rows={recommendations}
              columns={[
                { label: t("期间", "Period"), value: (r) => period(r.period) },
                ...ratingKeys.map((key, i) => ({
                  label: labels[i],
                  value: (r: Record<string, unknown>) => number(r[key], 0),
                  numeric: true,
                })),
              ]}
            />
          </details>
        </details>;
}

function InstitutionalActions({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const { locale } = useLocale();
  const [firm, setFirm] = useState(""),
    [action, setAction] = useState("all");
  const quote = data.context?.quote;
  const unitScale = targetUnitScale(quote?.quoteUnit, quote?.currency);
  const changes = objects(object(data.analyst).upgradesDowngrades)
    .map(recommendationChange)
    .sort((a, b) => b.date.localeCompare(a.date));
  const rows = changes.filter(
    (r) =>
      r.firm.toLowerCase().includes(firm.toLowerCase()) &&
      (action === "all" || r.action === action),
  );
  return (
      <Panel
        title={t("机构行动", "Institutional actions")}
        action={
          <Group gap="xs">
            <TextInput
              placeholder={t("筛选机构", "Filter firm")}
              aria-label={t("筛选机构", "Filter firm")}
              value={firm}
              onChange={(e) => setFirm(e.target.value)}
            />
            <Select
              w={130}
              aria-label={t("评级动作", "Rating action")}
              value={action}
              onChange={(v) => setAction(v ?? "all")}
              data={[
                { value: "all", label: t("全部动作", "All actions") },
                ...[...new Set(changes.map((r) => r.action))]
                  .filter(Boolean)
                  .map((v) => ({
                    value: v,
                    label:
                      {
                        up: t("上调", "Upgrade"),
                        down: t("下调", "Downgrade"),
                        main: t("维持", "Maintained"),
                        init: t("首次覆盖", "Initiated"),
                        reit: t("重申", "Reiterated"),
                      }[v] ?? v,
                  })),
              ]}
            />
          </Group>
        }
      >
        <EvidenceTable
          compactRecords
          label={t("机构行动记录", "Analyst action records")}
          rows={rows}
          columns={[
            { label: t("日期", "Date"), value: (r) => formatCalendarDate(r.date, locale) },
            { label: t("机构", "Firm"), value: (r) => r.firm },
            {
              label: t("评级变化", "Rating change"),
              value: (r) =>
                `${r.from ? ratingLabel(r.from, t) : "—"} → ${r.to ? ratingLabel(r.to, t) : "—"}`,
            },
            {
              label: t("公布目标价", "Target at announcement"),
              value: (r) => quoteValue(targetAmount(r.target, unitScale), quote?.currency),
              numeric: true,
            },
          ]}
        />
        <span role="status" className="mx-result-count">
          {rows.length} {rows.length === 1 ? t("条记录", "record") : t("条记录", "records")}
        </span>
      </Panel>
  );
}

export function EarningsEvents({ data }: { data: ResearchLensSnapshot }) {
  const { locale, timeZone } = useLocale();
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const a = object(data.analyst);
  const rows = objects(a.earningsEvents);
  const selected = rows.find((r) => r.id === params.get("eventId"));
  const displayed = selected ? [selected] : rows;
  const next = nextEarningsDate(data, new Date());
  const filings = objects(object(data.researchEvidence).filings).filter(
    (f) =>
      !selected ||
      Math.abs(Date.parse(str(f.date)) - Date.parse(str(selected.date))) <=
        3 * 86400000,
  );
  return (
    <Panel title={t("财报事件", "Earnings events")}>
      {rows.length > 0 && next && !displayed.some((event) => str(event.date).slice(0, 10) === next) && (
        <p>{t("下次财报 ", "Next earnings ") + formatCalendarDate(next, locale)}</p>
      )}
      {!rows.length ? (
        <Empty
          title={
            next
              ? t("下次财报 ", "Next earnings ") + formatCalendarDate(next, locale)
              : t("暂无可用财报日历", "Earnings calendar unavailable")
          }
        />
      ) : (
        <EvidenceTable
          compactRecords
          label={t("财报日历", "Earnings calendar")}
          rows={displayed}
          columns={[
            {
              label: t("事件日期", "Event date"),
              value: (r) => (
                <button
                  className="mx-text-link"
                  onClick={() => update({ eventId: str(r.id) })}
                >
                  {formatCalendarDate(str(r.date), locale)}
                </button>
              ),
            },
            {
              label: t("时间", "Time"),
              value: (r) =>
                r.instant
                  ? formatEventTime(str(r.instant), str(r.date), locale, timeZone)
                  : t("待定", "TBD"),
            },
            {
              label: t("状态", "Status"),
              value: (r) =>
                r.status === "reported"
                  ? t("已公布", "Reported")
                  : t("预计日期", "Estimated date"),
            },
            {
              label: "EPS · " + str(a.reportingCurrency),
              value: (r) => number(r.actualEps, 2),
              numeric: true,
            },
            {
              label: t("预期 EPS", "Estimated EPS"),
              value: (r) => number(r.estimatedEps, 2),
              numeric: true,
            },
            {
              label: t("超预期", "Surprise"),
              value: (r) => {
                const actual = numeric(r.actualEps), estimate = numeric(r.estimatedEps);
                return <Surprise gap={actual == null || estimate == null ? null : actual - estimate} places={telling([actual, estimate])} />;
              },
              numeric: true,
            },
            {
              label: t("价格", "Price"),
              value: (r) => (
                <Button
                  variant="subtle"
                  size="compact-xs"
                  onClick={() =>
                    update({
                      view: "technical",
                      technicalView: null,
                      chart: null,
                      priceRange: "1Y",
                      interval: "1d",
                      eventId: str(r.id),
                      eventDate: str(r.date),
                    })
                  }
                >
                  {t("查看走势", "View price")}
                </Button>
              ),
            },
          ]}
        />
      )}
      {selected && (
        <>
          <Button variant="subtle" onClick={() => update({ eventId: null })}>
            {t("全部事件", "All events")}
          </Button>
          <div className="mx-document-feed">
            {filings.map((f, i) => (
              <article key={i}>
                <time dateTime={str(f.date).slice(0, 10)}>{formatCalendarDate(str(f.date), locale)}</time>
                <a href={safeUrl(str(f.url))} target="_blank" rel="noreferrer">
                  {filingTitle(str(f.form), str(f.title), t)} ↗
                </a>
              </article>
            ))}
          </div>
          <TextLink
            href={`/research?ticker=${encodeURIComponent(data.ticker)}&view=ledger&notebook=filings&documentDate=${str(selected.date)}`}
          >
            {t("查找相关披露", "Find related filings")}
          </TextLink>
        </>
      )}
    </Panel>
  );
}
