"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { WorkspaceSheet } from "./overlay";
import { useBreakpoint } from "@/lib/hooks";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";

import type { ResearchLensSnapshot } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ChartRecords, ChartRecordsPanel, ChartRecordsTrigger } from "./chart-records";
import { EvidenceTable } from "./evidence-table";
import { Legend, Plot } from "./charts";
import { compact, compactTick, number, percent } from "@/workspace/data";
import { useChartColours } from "@/ui/charts/palette";
import { FONT_STACK } from "@/ui/theme";
import type { ChartReadout, ReadingKey } from "./chart-readout";
import { Empty, Metric, Panel, Pending, QueryError, QueryReadStatus, Segments, useCopy } from "./foundation";
import { minus } from "./reading-figures";
import { readingTone } from "./reading-format";
import { FinancialStatements } from "./research-company";
import {
  BusinessSegments,
  CompanyOwnership,
  DividendHistory,
} from "./research-evidence";
import {
  factIndex,
  factPeriods,
  incomeBridge,
  metricNames,
  type Observation,
} from "./research-facts";
import { researchLensQuery } from "./research-queries";
import { financialSections, ResearchReading, useApproached } from "./research-reading";
import { useRouteState } from "./route-state";
import { Sparkbars } from "./sparks";
import { chartNumber } from "./research-chart-format";
import { SelectPicker } from "./picker";

export function FinancialWorkbench({
  data,
  initialMode,
  ticker = data.ticker,
  revision,
  preview = false,
  earningsBrief,
}: {
  data: ResearchLensSnapshot;
  initialMode?: string;
  /** The route's listing, which also requests the complete statements. */
  ticker?: string;
  revision?: string | null;
  preview?: boolean;
  /** The earnings brief opens the page, ahead of the reporting-period controls. */
  earningsBrief?: ReactNode;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { params, update } = useRouteState("push");
  const colours = useChartColours();
  const phone = useBreakpoint("phone");
  const [detail, setDetail] = useState<Observation | null>(null);
  const facts = data.financialFacts;
  if (!facts?.periods?.length)
    return (
      <>
        {earningsBrief}
        <Panel>
          <Empty title={t("暂无可用财报", "No financial statements available")} />
        </Panel>
      </>
    );
  // Segments read the same parameter and keep an annual view when TTM is selected.
  const frequency = [
    "annual",
    "quarterly",
    "ttm",
    "semiannual",
    "irregular",
  ].includes(params.get("frequency") ?? "")
    ? params.get("frequency")!
    : "annual";
  const periods = factPeriods(facts, frequency);
  const period =
    periods.find((p) => p.id === params.get("period")) ?? periods.at(-1);
  const chart = params.get("metricGroup") ?? "income";
  const weightedShares = params.get("shareBasis") === "weighted";
  const get = factIndex(facts);
  const label = (key: string) =>
    metricNames[key]
      ? t(...metricNames[key])
      : key === "taxAndOther"
        ? t("税费及其他净项", "Tax & other net items")
        : key;
  const format = (o?: Observation) =>
    o?.value == null
      ? "—"
      : o.unit === "ratio"
        ? percent(o.value, false, 2)
        : o.unit === "perShare"
          ? number(o.value, 2)
          : compact(o.value, locale);
  const selected = (key: string) => (period ? get(period.id, key) : undefined);
  const previous = period ? periods[periods.indexOf(period) - 1] : undefined;
  const prior = (key: string) => (previous ? get(previous.id, key)?.value ?? null : null);
  const groups: Record<string, string[]> = {
    income: ["revenue", "operatingIncome", "netIncome"],
    margins: ["grossMargin", "operatingMargin", "netMargin"],
    cashflow: ["operatingCashflow", "capex", "freeCashflow"],
    balance: ["cash", "debt"],
    returns: ["roe", "roa"],
    shares: weightedShares
      ? ["basicShares", "dilutedShares"]
      : ["shareCount", "dilutedShares"],
    allocation: ["freeCashflow", "buybacks", "dividends"],
  };
  const chartMetrics = groups[chart] ?? groups.income;
  const ratio = chart === "margins" || chart === "returns";
  const statementRows = {
    income: [
      "revenue",
      "revenueGrowth",
      "costOfRevenue",
      "grossProfit",
      "grossMargin",
      "operatingExpense",
      "operatingIncome",
      "operatingMargin",
      "pretaxIncome",
      "tax",
      "netIncome",
      "netMargin",
      "eps",
      "epsGrowth",
      "dilutedShares",
    ],
    balance: ["cash", "assets", "debt", "equity", "shareCount"],
    cash: ["operatingCashflow", "capex", "freeCashflow", "buybacks", "dividends"],
  };
  const bridge = incomeBridge((key) => selected(key)?.value);
  const activeDetail =
    detail ??
    (params.get("fact") ? (selected(params.get("fact")!) ?? null) : null);
  // Readings name the period as the axis does; the panel carries the currency once.
  const lineChart = ratio || chart === "shares";
  const historyColours = [colours.brand, colours.secondary, colours.accent];
  const historyKey = (line: number): ReadingKey => ({ colour: historyColours[line], kind: lineChart ? "line" : "bar" });
  const historyValue = (value: number | null | undefined) => value == null ? "—"
    : ratio ? minus(percent(value, false, 2)) : chart === "shares" ? compact(value, locale) : minus(chartNumber(value, locale));
  const historyReadout: ChartReadout = {
    positions: periods.map((_, index) => index),
    read: (index) => {
      const at = periods[index];
      if (!at) return null;
      const [lead, ...rest] = chartMetrics.map((key, line) => ({ label: label(key), value: historyValue(get(at.id, key)?.value), key: historyKey(line) }));
      return { time: at.label, primary: lead, groups: [rest] };
    },
    // Lines get a dot where they are read; a bar is already marked by the cursor band.
    marks: lineChart ? (index) => chartMetrics.flatMap((key, line) => {
      const value = periods[index] ? get(periods[index].id, key)?.value : null;
      return value == null ? [] : [{ value, colour: historyColours[line] }];
    }) : undefined,
    latest: periods.length ? historyValue(get(periods.at(-1)!.id, chartMetrics[0])?.value) : "—",
  };
  // Each step's own amount is on its bar; the reading adds its share of revenue.
  const revenueTotal = bridge[0]?.to;
  const bridgeReading: ChartReadout = {
    positions: bridge.map((_, index) => index),
    read: (index) => {
      const step = bridge[index];
      if (!step) return null;
      const amount = step.to - step.from;
      return {
        time: label(step.metric),
        primary: { value: minus(chartNumber(amount, locale)), tone: step.total ? undefined : readingTone(amount) },
        groups: step.metric !== "revenue" && revenueTotal ? [[{ label: t("占营收", "Of revenue"), value: percent(Math.abs(amount) / revenueTotal, false, 1) }]] : undefined,
      };
    },
    latest: revenueTotal != null ? minus(chartNumber(bridge.at(-1)!.to, locale)) : "—",
  };
  const detailReadout: ChartReadout | undefined = activeDetail ? {
    positions: periods.map((_, index) => index),
    read: (index) => {
      const at = periods[index];
      if (!at) return null;
      const ratioUnit = activeDetail.unit === "ratio";
      const value = get(at.id, activeDetail.metric)?.value ?? null;
      const before = index > 0 ? get(periods[index - 1].id, activeDetail.metric)?.value ?? null : null;
      const shown = (figure: number) => ratioUnit ? minus(percent(figure, false, 2)) : minus(chartNumber(figure, locale));
      const change = value == null || before == null ? null : ratioUnit ? (value - before) * 100 : before !== 0 ? value / Math.abs(before) - 1 : null;
      const changeText = change == null ? null : ratioUnit ? minus((change > 0 ? "+" : "") + change.toFixed(2)) + " pp" : minus(percent(change, true, 1));
      return {
        time: at.label,
        primary: { value: value == null ? "—" : shown(value) },
        // A supporting row stays in ink; only the step's own amount takes a tone.
        groups: changeText ? [[{ label: t("较上期", "vs previous"), value: changeText }]] : undefined,
      };
    },
    marks: (index) => {
      const value = periods[index] ? get(periods[index].id, activeDetail.metric)?.value : null;
      return value == null ? [] : [{ value, colour: colours.brand }];
    },
    latest: periods.length ? historyValue(get(periods.at(-1)!.id, activeDetail.metric)?.value) : "—",
  } : undefined;
  const statementTitles = {
    income: t("利润表", "Income statement"),
    balance: t("资产负债表", "Balance sheet"),
    cash: t("现金流量表", "Cash flow statement"),
  };
  // Statements need a complete period; the other sections read their own records.
  const sections = period
    ? financialSections
    : financialSections.filter(([id]) => !(id in statementTitles));
  return (
    <>
      <ResearchReading
        sections={sections}
        parameter="financialMode"
        initial={initialMode}
        before={
          <>
          {earningsBrief}
          <div className="mx-research-context-toolbar">
          <div className="flex flex-wrap items-center gap-mx-xs">
            <Segments
              label={t("报告频率", "Reporting frequency")}
              value={frequency}
              onChange={(v) => update({ frequency: v, period: null })}
              options={[
                { value: "annual", label: t("年度", "Annual") },
                { value: "quarterly", label: t("季度", "Quarterly") },
                { value: "ttm", label: "TTM" },
                ...(facts.periods.some((p) => p.kind === "semiannual")
                  ? [{ value: "semiannual", label: t("半年度", "Half-year") }]
                  : []),
                ...(facts.periods.some((p) => p.kind === "irregular")
                  ? [{ value: "irregular", label: t("过渡期", "Transition") }]
                  : []),
              ]}
            />
            <SelectPicker
              aria-label={t("选择报告期", "Reporting period")}
              value={period?.id ?? null}
              options={periods
                .toReversed()
                .map((p) => ({ value: p.id, label: p.label }))}
              onChange={(v) => update({ period: v })}
              style={{ width: 205 }}
            />
          </div>
          </div>
          </>
        }
      >
      {!period ? (
        <div id="research-performance">
          <Panel title={t("经营分析", "Operating analysis")}>
            <Empty
              title={t(
                "没有完整的四个季度",
                "Four complete quarters are unavailable",
              )}
            />
          </Panel>
        </div>
      ) : (
        <>
          <section id="research-performance">
            <h2>{t("经营分析", "Operating analysis")}</h2>
            <Panel
              className="mx-period-summary"
              // The period picker above already shows the period; the heading keeps it for assistive technology.
              title={<span className="sr-only">{period.label}</span>}
              action={
                <span className="mx-unit">
                  {facts.currency ?? t("币种未提供", "Currency unavailable")}
                </span>
              }
            >
              <div className="mx-metric-grid">
                {["revenue", "revenueGrowth", "netMargin", "freeCashflow"].map((key) => {
                  const value = selected(key)?.value ?? null;
                  const revenue = selected("revenue")?.value ?? null;
                  // Each figure carries the comparison that gives it meaning.
                  const note =
                    key === "revenue" && previous && prior(key) != null
                      ? t("上期 ", "Prior ") + format(get(previous.id, key))
                      : key === "revenueGrowth" && prior(key) != null
                      ? t("上期 ", "Prior ") + percent(prior(key), true, 1)
                      : key === "netMargin" && value != null && prior(key) != null
                        ? (locale === "zh" ? "较上期 " : "vs prior ") +
                          (value - prior(key)! >= 0 ? "+" : "") +
                          number((value - prior(key)!) * 100, 1) +
                          t(" 个百分点", " pp")
                        : key === "freeCashflow" && value != null && revenue
                          ? t("占营收 ", "Of revenue ") + percent(value / revenue, false, 1)
                          : undefined;
                  return (
                    <button
                      type="button"
                      className="mx-fact-button"
                      key={key}
                      onClick={() => setDetail(selected(key) ?? null)}
                    >
                      <Metric
                        label={label(key)}
                        value={
                          key === "revenueGrowth"
                            ? percent(value, true, 1)
                            : key === "netMargin"
                              ? percent(value, false, 1)
                              : format(selected(key))
                        }
                        tone={key === "revenueGrowth" || key === "freeCashflow" ? (value == null ? undefined : value < 0 ? "down" : undefined) : undefined}
                        note={note}
                      />
                    </button>
                  );
                })}
              </div>
            </Panel>
              <Panel
                title={t("经营历史", "Operating history")}
                help={
                  chart === "shares"
                    ? t(
                        "期末股数是时点余额，平均股数是期间加权值，两者的差额不代表稀释。EPS 股数视图对照同期间基本与摊薄平均股数；TTM 使用四个季度平均值。",
                        "Period-end shares are a balance; weighted-average shares cover a period. Their difference is not dilution. The EPS view compares basic and diluted averages for the same period; TTM uses four-quarter means.",
                      )
                    : undefined
                }
                action={
                  <SelectPicker
                    className="phone:w-[180px]"
                    aria-label={t("历史指标", "Historical metrics")}
                    value={chart}
                    onChange={(v) => update({ metricGroup: v })}
                    options={[
                      {
                        value: "income",
                        label: t("营收与利润", "Revenue & profit"),
                      },
                      { value: "margins", label: t("利润率", "Margins") },
                      {
                        value: "cashflow",
                        label: t("现金流", "Cash flow"),
                      },
                      {
                        value: "balance",
                        label: t("现金与债务", "Cash & debt"),
                      },
                      {
                        value: "returns",
                        label: t("资本回报", "Capital returns"),
                      },
                      {
                        value: "shares",
                        label: t("股数变化", "Share-count changes"),
                      },
                      {
                        value: "allocation",
                        label: t("股东回报", "Capital allocation"),
                      },
                    ]}
                  />
                }
              >
                {chart === "shares" && (
                  <Segments
                    label={t("股数口径", "Share-count basis")}
                    value={weightedShares ? "weighted" : "outstanding"}
                    onChange={(v) =>
                      update({ shareBasis: v === "weighted" ? v : null })
                    }
                    options={[
                      {
                        value: "outstanding",
                        label: t("期末与平均股数", "Period-end & average"),
                      },
                      {
                        value: "weighted",
                        label: t("EPS 加权股数", "EPS weighted averages"),
                      },
                    ]}
                  />
                )}
                <Plot
                  label={t("经营历史", "Operating history")}
                  height={320}
                  readout={historyReadout}
                  option={(c) => ({
                    grid: {
                      left: 70,
                      right: ratio ? 78 : chart === "shares" ? 68 : 20,
                      top: 25,
                      bottom: 45,
                    },
                    xAxis: {
                      type: "category",
                      data: periods.map((p) => p.label),
                      axisLabel: { color: c.axis },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    },
                    yAxis: {
                      type: "value",
                      scale: chart === "shares" || ratio,
                      axisLabel: {
                        color: c.axis,
                        formatter: (n: number) =>
                          ratio ? percent(n) : compactTick(n, locale),
                      },
                    },
                    series: chartMetrics.map((key, i) => ({
                      type: ratio || chart === "shares" ? "line" : "bar",
                      name: label(key),
                      data: periods.map((p) => get(p.id, key)?.value ?? null),
                      connectNulls: false,
                      showSymbol: periods.length < 6,
                      symbolSize: 6,
                      barMaxWidth: 34,
                      itemStyle: { color: [c.brand, c.secondary, c.accent][i] },
                      lineStyle: { color: [c.brand, c.secondary, c.accent][i] },
                      endLabel:
                        ratio || chart === "shares"
                          ? {
                              show: true,
                              formatter: (p) =>
                                chart === "shares"
                                  ? compact(p.value, locale)
                                  : label(key),
                              color: c.text,
                              fontSize: 12,
                            }
                          : undefined,
                      labelLayout: { moveOverlap: "shiftY" },
                    })),
                  })}
                />
                <Legend
                  items={chartMetrics.map((key, i) => ({
                    label: label(key),
                    colour: historyColours[i],
                  }))}
                />
                <details className="mx-chart-data">
                <summary>{t("各期数值", "Values by period")}</summary>
                <Table containerProps={{ className: "mx-table-scroll" }} label={t("图表数据", "Chart data")} className="mx-financial-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("报告期", "Period")}</TableHead>
                      {chartMetrics.map((key) => (
                        <TableHead scope="col" key={key}>{label(key)}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {periods.toReversed().map((p) => (
                      <TableRow
                        key={p.id}
                        data-active={p.id === period.id || undefined}
                      >
                        <TableHead scope="row">
                          <button onClick={() => update({ period: p.id })}>
                            {p.label}
                          </button>
                        </TableHead>
                        {chartMetrics.map((key) => (
                          <TableCell key={key}>
                            <button
                              type="button"
                              aria-label={`${label(key)} · ${p.label} · ${format(get(p.id, key))}`}
                              onClick={() =>
                                setDetail(get(p.id, key) ?? null)
                              }
                            >
                              {format(get(p.id, key))}
                            </button>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </details>
              </Panel>
              {bridge.length > 0 && (
                // The summary above carries the currency once; each step's reading adds its share of revenue.
                <ChartRecords>
                <Panel title={t("从营收到净利润", "Revenue to net income")}
                  action={<ChartRecordsTrigger label={t("查看各步读数", "Values by step")} placement="heading" />}>
                  <Plot
                    research
                    label={t("利润桥接", "Income bridge")}
                    height={305}
                    readout={bridgeReading}
                    option={(c) => ({
                      xAxis: {
                        type: "category",
                        data: bridge.map((b) => label(b.metric)),
                        axisLabel: {
                          color: c.axis,
                          interval: 0,
                          width: 70,
                          overflow: "break",
                        },
                        axisTick: { show: false },
                      },
                      yAxis: {
                        type: "value",
                        axisLabel: {
                          color: c.axis,
                          formatter: (n: number) => compactTick(n, locale),
                        },
                      },
                      series: [
                        {
                          type: "custom",
                          data: bridge.map((b, i) => [i, b.from, b.to]),
                          encode: { x: 0, y: [1, 2] },
                          renderItem: (_params, api) => {
                            const i = Number(api.value(0));
                            const from = api.coord([i, api.value(1)]);
                            const to = api.coord([i, api.value(2)]);
                            const size = api.size?.([1, 0]);
                            const width = Math.min(
                              58,
                              Math.abs(
                                Array.isArray(size) ? size[0] : (size ?? 40),
                              ) * 0.55,
                            );
                            const b = bridge[i];
                            const top = Math.min(from[1], to[1]);
                            // Each step carries its own amount; no separate row repeats it.
                            return {
                              type: "group",
                              children: [
                                {
                                  type: "rect",
                                  shape: {
                                    x: from[0] - width / 2,
                                    y: top,
                                    width,
                                    height: Math.max(1, Math.abs(to[1] - from[1])),
                                  },
                                  style: {
                                    fill: b.total
                                      ? c.brand
                                      : b.to < b.from
                                        ? c.negative
                                        : c.positive,
                                  },
                                },
                                // Keep every value in the point reader and records when narrow.
                                ...(!phone || i === 0 || i === bridge.length - 1 ? [{
                                  type: "text" as const,
                                  style: {
                                    x: from[0],
                                    y: top - 6,
                                    text: compact(b.to - b.from, locale),
                                    fill: c.text,
                                    fontSize: 12,
                                    fontFamily: FONT_STACK,
                                    align: "center" as const,
                                    verticalAlign: "bottom" as const,
                                  },
                                }] : []),
                              ],
                            };
                          },
                        },
                      ],
                    })}
                  />
                  <ChartRecordsPanel>
                    <EvidenceTable chart label={t("利润桥接", "Income bridge")} rows={bridge} columns={[
                      { label: t("项目", "Step"), value: ({ metric }) => label(metric) },
                      { label: t("金额", "Amount"), numeric: true, value: ({ from, to }) => number(to - from, 2) },
                    ]} />
                  </ChartRecordsPanel>
                </Panel>
                </ChartRecords>
              )}
          </section>
          {(["income", "balance", "cash"] as const).map((section) => (
            <div id={"research-" + section} key={section}>
            <Panel title={statementTitles[section]}>
              <Table containerProps={{ className: "mx-table-scroll" }} stickyHeader label={statementTitles[section]} className="mx-financial-table">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{facts.currency}</TableHead>
                    <TableHead scope="col" className="mx-spark-cell">
                      <span className="sr-only">{t("趋势", "Trend")}</span>
                    </TableHead>
                    {periods.toReversed().map((p) => (
                      <TableHead scope="col" key={p.id}>
                        {p.label}
                        {p.actualEnd && <small>{formatCalendarDate(p.actualEnd, locale)}</small>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statementRows[section]
                    .filter((key) =>
                      periods.some((p) => get(p.id, key)?.value != null),
                    )
                    .map((key) => (
                      <TableRow
                        key={key}
                        className={
                          /Margin|Growth/.test(key) ? "mx-submetric" : ""
                        }
                      >
                        <TableHead scope="row">{label(key)}</TableHead>
                        <TableCell className="mx-spark-cell">
                          <Sparkbars values={periods.map((p) => get(p.id, key)?.value)} />
                        </TableCell>
                        {periods.toReversed().map((p) => (
                          <TableCell key={p.id}>
                            <button
                              type="button"
                              aria-label={`${label(key)} · ${p.label} · ${format(get(p.id, key))}`}
                              onClick={() =>
                                setDetail(get(p.id, key) ?? null)
                              }
                            >
                              {format(get(p.id, key))}
                            </button>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Panel>
            </div>
          ))}
        </>
      )}
      <div id="research-business"><BusinessSegments data={data} /></div>
      <div id="research-ownership">
        <CompanyOwnership data={data} />
        <DividendHistory data={data} />
      </div>
      <CompleteStatements ticker={ticker} revision={revision} preview={preview} frequency={frequency} />
      </ResearchReading>
      <WorkspaceSheet
        width={620}
        open={Boolean(activeDetail)}
        onClose={() => {
          setDetail(null);
          update({ fact: null });
        }}
        closeLabel={t("关闭报表详情", "Close financial details")}
        title={activeDetail ? label(activeDetail.metric) : ""}
      >
        {activeDetail && (
          <div className="mx-stack">
            <div className="mx-detail-value">
              {activeDetail.unit === "ratio"
                ? percent(activeDetail.value, false, 2)
                : number(
                    activeDetail.value,
                    activeDetail.unit === "shares" ? 0 : 4,
                  )}{" "}
              <small>{activeDetail.unit === "ratio" ? "" : activeDetail.currency}</small>
            </div>
            <p>
              {
                facts.periods?.find((p) => p.id === activeDetail.periodId)
                  ?.label
              }
            </p>
            {activeDetail.reason && (
              <p>
                {t("无法计算：", "Unavailable: ")}
                {activeDetail.reason}
              </p>
            )}
            {activeDetail.formula && <p>{activeDetail.formula}</p>}
            <Plot
              label={label(activeDetail.metric)}
              height={220}
              readout={detailReadout}
              option={(c) => ({
                xAxis: {
                  type: "category",
                  data: periods.map((p) => p.label),
                  axisLabel: { color: c.axis },
                },
                yAxis: {
                  type: "value",
                  scale: true,
                  axisLabel: {
                    color: c.axis,
                    formatter: (n: number) =>
                      activeDetail.unit === "ratio" ? percent(n) : compactTick(n, locale),
                  },
                },
                series: [
                  {
                    type: "line",
                    connectNulls: false,
                    data: periods.map(
                      (p) => get(p.id, activeDetail.metric)?.value ?? null,
                    ),
                    lineStyle: { color: c.brand },
                    itemStyle: { color: c.brand },
                    symbolSize: 6,
                  },
                ],
              })}
            />
            <h3>{t("数据来源", "Source evidence")}</h3>
            <ul className="mx-source-list">
              {(activeDetail.evidence ?? []).map((source, i) => (
                <li key={i}>
                  <strong>{source.field}</strong>
                  <span>{source.source}</span>
                  {source.publishedAt && <time>{source.publishedAt}</time>}
                  {source.url && (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {t("原始披露", "Original filing")} ↗
                    </a>
                  )}
                  <code>{source.version.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
            <Button
              variant="secondary"
              onClick={() => {
                update({ financialMode: "full" });
                setDetail(null);
              }}
            >
              {t("查看完整报表", "Open complete statement")}
            </Button>
          </div>
        )}
      </WorkspaceSheet>
    </>
  );
}

/** Every reported row loads as the reader approaches it, or at once when a link opens it. */
function CompleteStatements({ ticker, revision, preview, frequency }: {
  ticker: string;
  revision?: string | null;
  preview: boolean;
  frequency: string;
}) {
  const t = useCopy();
  const { params } = useRouteState("push");
  const [box, near] = useApproached(params.get("financialMode") === "full");
  const lens = useQuery({ ...researchLensQuery(ticker, "fundamentals", revision, "full", preview), enabled: near });
  const title = t("完整报表", "All reported rows");
  return (
    <div id="research-full" ref={box}>
      <QueryReadStatus key={ticker} label={title} failed={lens.isError && !lens.data} ready={!!lens.data} error={lens.error} />
      {lens.data ? (
        <FinancialStatements data={lens.data} controlledFrequency={frequency} title={title} />
      ) : (
        <Panel title={title}>
          {lens.isError ? <QueryError retry={lens.refetch} error={lens.error} /> : <Pending />}
        </Panel>
      )}
    </div>
  );
}

