"use client";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Group, Select, TextInput } from "@mantine/core";
import { useState } from "react";
import {
  analystVerdict,
  nextEarningsDate,
  normalizeRatingRow,
  ratingKeys,
  recommendationChange,
} from "./analyst-data";
import { Plot } from "./charts";
import { currency, number, object, objects, percent, safeUrl, str, tone } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Empty, Metric, Panel, Segments, TextLink, useCopy } from "./foundation";
import { AnalystExpectations } from "./research-expectations";
import { AnalystEstimates, forecastPeriodLabel } from "./research-forecasts";
import type { ResearchPrice } from "./research-price-basis";
import { useRouteState } from "./route-state";
import { chartName, chartNumber } from "./research-chart-format";

export function AnalystView({
  data,
  revision,
  price,
}: {
  data: ResearchLensSnapshot;
  revision?: string | null;
  price?: ResearchPrice;
}) {
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const section = params.get("analystView") ?? "forecast";
  return (
    <>
      {data.analyst && <AnalystVerdict data={data} price={price} />}
      <Segments
        label={t("预期与事件内容", "Estimates & events content")}
        value={section}
        onChange={(v) => update({ analystView: v })}
        options={[
          { value: "forecast", label: t("业绩预期", "Earnings estimates") },
          { value: "ratings", label: t("评级与目标价", "Ratings & targets") },
          { value: "events", label: t("财报事件", "Earnings events") },
        ]}
      />
      {section === "events" ? (
        <EarningsEvents data={data} />
      ) : !data.analyst ? (
        <Panel>
          <Empty title={t("暂无分析师覆盖", "No analyst coverage")} />
        </Panel>
      ) : section === "ratings" ? (
        <>
          <AnalystExpectations data={data} revision={revision} price={price} />
          <RatingsAndActions data={data} />
        </>
      ) : (
        <>
          <AnalystEstimates data={data} />
          <EpsTimeline data={data} />
          <EstimateRevisions data={data} />
        </>
      )}
    </>
  );
}

const consensusLabels: Record<string, [string, string]> = {
  strongbuy: ["强烈买入", "Strong buy"],
  buy: ["买入", "Buy"],
  hold: ["持有", "Hold"],
  sell: ["卖出", "Sell"],
  strongsell: ["强烈卖出", "Strong sell"],
  underperform: ["跑输", "Underperform"],
};

/** One line of conclusions before the evidence below it. */
function AnalystVerdict({ data, price }: { data: ResearchLensSnapshot; price?: ResearchPrice }) {
  const t = useCopy();
  const { locale } = useLocale();
  const code = price?.currency ?? data.context?.quote.currency ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const verdict = analystVerdict(
    object(data.analyst),
    price?.price ?? data.context?.quote.price ?? object(data.market).spot,
    today,
  );
  const nextReport = nextEarningsDate(data, today);
  const label = verdict.consensus ? consensusLabels[verdict.consensus] : null;
  const up = verdict.revisionsUp30;
  const down = verdict.revisionsDown30;
  return (
    <Panel className="mx-analyst-verdict">
      <div className="mx-metric-grid">
        <Metric
          label={t("分析师共识", "Consensus")}
          value={label ? t(label[0], label[1]) : "—"}
          note={verdict.analysts ? (locale === "zh" ? `${verdict.analysts} 位分析师` : `${verdict.analysts} analysts`) : undefined}
        />
        <Metric
          label={t("中位目标价", "Median target")}
          value={percent(verdict.targetChange, true, 1)}
          note={verdict.targetMedian != null ? currency(verdict.targetMedian, code || "USD", 2) : undefined}
        />
        <Metric
          label={t("本季 EPS 预期 · 90 天", "Quarter EPS estimate · 90 days")}
          value={percent(verdict.estimateChange90, true, 1)}
          tone={tone(verdict.estimateChange90)}
          note={up != null && down != null
            ? (locale === "zh" ? `近 30 天上修 ${up} · 下修 ${down}` : `30 days: ${up} up · ${down} down`)
            : undefined}
        />
        <Metric
          label={t("下次财报", "Next report")}
          value={nextReport ? formatCalendarDate(nextReport, locale) : "—"}
          note={verdict.lastSurprise != null
            ? (verdict.lastSurprise >= 0 ? t("上季超预期 ", "Last quarter beat by ") : t("上季低于预期 ", "Last quarter missed by "))
              + percent(Math.abs(verdict.lastSurprise), false, 1)
            : undefined}
        />
      </div>
    </Panel>
  );
}

/** Quarter ends read as month and year; estimates keep their marker. */
function quarterLabel(date: string, future: boolean, locale: "zh" | "en", estimate: string) {
  const month = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { year: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(date + "T00:00:00Z"));
  return future ? month + " " + estimate : month;
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
  const rows = [...actual, ...future].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (!rows.length) return null;
  return (
    <Panel
      title={t("季度每股收益", "Quarterly EPS")}
      action={<span>{code}</span>}
      help={t(
        "实际与预期均保留分析师数据源的 EPS 口径，可能经过调整，不与报表中的 GAAP EPS 混合。空心点代表预期；未来没有实际值。",
        "Both reported and estimated EPS retain the analyst provider’s basis, which may be adjusted. They are not mixed with statement GAAP EPS. Hollow points are estimates; future periods have no reported value.",
      )}
    >
      <Plot
        research
        height={265}
        label={t("季度 EPS 实际与预期", "Reported and estimated quarterly EPS")}
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
            scale: true,
            name: code,
            axisLabel: { color: c.axis },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          series: [
            {
              type: "scatter",
              name: t("实际", "Reported"),
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
              itemStyle: { color: c.accent },
            },
          ],
          tooltip: {
            formatter: (input) => {
              const entries = Array.isArray(input) ? input : [input];
              return [
                String(entries[0]?.name ?? "") + " · " + code,
                ...entries.map(
                  (e) =>
                    `${chartName(String(e.seriesName))}   ${chartNumber(e.value)}`,
                ),
              ].join("\n");
            },
          },
        })}
      />
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
              label: t("实际", "Reported"),
              value: (r) => number(r.actual, 2),
              numeric: true,
            },
            {
              label: t("预期", "Estimate"),
              value: (r) => number(r.estimate, 2),
              numeric: true,
            },
            {
              label: t("惊喜幅度", "Surprise"),
              value: (r) => percent(r.surprise, true),
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
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const a = object(data.analyst),
    trend = objects(a.epsTrend),
    revisions = objects(a.epsRevisions);
  if (!trend.length) return null;
  const key = (r: Record<string, unknown>) => str(r.index ?? r.period);
  const selected =
    trend.find((r) => key(r) === params.get("forecastPeriod")) ?? trend[0];
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
  return (
    <Panel
      title={t("盈利预期修订", "EPS estimate revisions")}
      action={
        <Select
          w={240}
          aria-label={t("修订对应的报告期", "Revision fiscal period")}
          value={key(selected)}
          onChange={(v) => update({ forecastPeriod: v })}
          data={trend.map((r) => ({
            value: key(r),
            label: forecastPeriodLabel(a, key(r), t),
          }))}
        />
      }
    >
      <Plot
        height={200}
        label={t(
          "同一财期的 EPS 预期修订",
          "EPS estimate revisions for one fiscal period",
        )}
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
            scale: true,
            axisLabel: { color: c.axis },
            splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
          },
          series: [
            {
              type: "line",
              data: days.map((d) => numeric(selected[d])),
              connectNulls: false,
              symbolSize: 6,
              lineStyle: { color: c.brand, width: 2 },
            },
          ],
          tooltip: {
            formatter: (input) => {
              const entries = Array.isArray(input) ? input : [input];
              return [
                String(entries[0]?.name ?? "") + " · " + code,
                ...entries.map(
                  (e) =>
                    `${chartName(String(e.seriesName))}   ${chartNumber(e.value)}`,
                ),
              ].join("\n");
            },
          },
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

function RatingsAndActions({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [firm, setFirm] = useState(""),
    [action, setAction] = useState("all");
  const a = object(data.analyst),
    recommendations = objects(a.recommendations)
      .map(normalizeRatingRow)
      .reverse();
  const changes = objects(a.upgradesDowngrades)
    .map(recommendationChange)
    .sort((a, b) => b.date.localeCompare(a.date));
  const rows = changes.filter(
    (r) =>
      r.firm.toLowerCase().includes(firm.toLowerCase()) &&
      (action === "all" || r.action === action),
  );
  const labels = [
    t("强烈买入", "Strong buy"),
    t("买入", "Buy"),
    t("持有", "Hold"),
    t("卖出", "Sell"),
    t("强烈卖出", "Strong sell"),
  ];
  const period = (v: unknown) =>
    str(v) === "0m"
      ? t("当前", "Current")
      : /^-\d+m$/.test(str(v))
        ? Math.abs(parseInt(str(v))) + t(" 个月前", " months ago")
        : str(v);
  return (
    <>
      {recommendations.length > 0 && (
        <Panel title={t("评级分布历史", "Historical rating distribution")}>
          <Plot
            height={260}
            label={t(
              "各类评级的分析师数量",
              "Analyst counts by rating category",
            )}
            option={(c) => ({
              legend: {
                bottom: 0,
                type: "scroll",
                textStyle: { color: c.text },
              },
              grid: { top: 20, bottom: 65, left: 44, right: 18 },
              xAxis: {
                type: "category",
                data: recommendations.map((r) => period(r.period)),
                axisLabel: { color: c.axis },
              },
              yAxis: {
                type: "value",
                minInterval: 1,
                axisLabel: { color: c.axis },
                splitLine: { lineStyle: { color: c.grid } },
              },
              series: ratingKeys.map((key, i) => ({
                type: "bar",
                name: labels[i],
                stack: "ratings",
                barMaxWidth: 44,
                itemStyle: {
                  color: [
                    c.positive,
                    c.secondary,
                    c.warning,
                    c.accent,
                    c.negative,
                  ][i],
                },
                data: recommendations.map((r) => numeric(r[key])),
              })),
            })}
          />
          <details className="mx-chart-data">
            <summary>{t("评级数量", "Rating counts")}</summary>
            <EvidenceTable
              label={t("评级数量明细", "Rating count details")}
              rows={recommendations}
              columns={[
                { label: t("时间", "Period"), value: (r) => period(r.period) },
                ...ratingKeys.map((key, i) => ({
                  label: labels[i],
                  value: (r: Record<string, unknown>) => number(r[key], 0),
                  numeric: true,
                })),
              ]}
            />
          </details>
        </Panel>
      )}
      <Panel
        title={t("机构行动", "Analyst actions")}
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
          label={t("机构行动记录", "Analyst action records")}
          rows={rows}
          columns={[
            { label: t("日期", "Date"), value: (r) => r.date },
            { label: t("机构", "Firm"), value: (r) => r.firm },
            {
              label: t("评级变化", "Rating change"),
              value: (r) => `${r.from || "—"} → ${r.to || "—"}`,
            },
            {
              label: t("目标价", "Target"),
              value: (r) =>
                r.target != null && r.target > 0
                  ? currency(r.target, data.context?.quote.currency ?? "", 2)
                  : "—",
              numeric: true,
            },
          ]}
        />
        <span role="status" className="mx-result-count">
          {rows.length} {t("条记录", "records")}
        </span>
      </Panel>
    </>
  );
}

export function EarningsEvents({ data }: { data: ResearchLensSnapshot }) {
  const { locale } = useLocale();
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const a = object(data.analyst),
    calendar = object(object(data.fundamentals).earningsCalendar);
  const rows = objects(a.earningsEvents);
  const selected = rows.find((r) => r.id === params.get("eventId"));
  const filings = objects(object(data.researchEvidence).filings).filter(
    (f) =>
      !selected ||
      Math.abs(Date.parse(str(f.date)) - Date.parse(str(selected.date))) <=
        3 * 86400000,
  );
  return (
    <Panel title={t("财报事件", "Earnings events")}>
      {!rows.length ? (
        <Empty
          title={
            (calendar.earningsDates as string[] | undefined)?.length
              ? t("下一财报窗口：", "Next earnings window: ") +
                (calendar.earningsDates as string[])
                  .map((d) => d.slice(0, 10))
                  .join(" – ")
              : t("暂无可用财报日历", "Earnings calendar unavailable")
          }
        />
      ) : (
        <EvidenceTable
          label={t("财报日历", "Earnings calendar")}
          rows={selected ? [selected] : rows}
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
                  ? new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: str(r.timezone) || "UTC",
                      timeZoneName: "short",
                    }).format(new Date(str(r.instant)))
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
                  {str(f.form)} · {str(f.title)} ↗
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
