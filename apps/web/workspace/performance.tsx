"use client";

import { Select } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { deepestDrawdown } from "@/lib/portfolio/drawdown-episodes";
import { ReturnGrid } from "./performance-return-grid";
import { DrawdownReading, drawdownMarks } from "./drawdown-reading";
import { drawdowns, minimumObserved } from "@/lib/portfolio/math";
import { useMemo, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import type { DashboardLens, NavPoint, RiskMetrics } from "@/lib/types";
import { HistoryChart, Legend, type ChartLine } from "./charts";
import { TimelineChart } from "./timeline-chart";
import type { TimelineLayer } from "./timeline-option";
import type { TimelineReading } from "./timeline-reading";
import { comparisonFigures, readingTone, signedPercent } from "./reading-format";
import { moneyTimelineReading } from "./money-readings";
import { DataBasis } from "./reading-card";
import { number, percent, tone } from "@/workspace/data";
import { inRange, navNumber, periodReturn, type Scope } from "@/lib/portfolio/nav";
import { benchmarkValue, rememberBenchmark, usePerformanceBenchmark } from "./assistant/benchmark";
import { benchmarkComparison } from "@/lib/portfolio/benchmark-comparison";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  Segments,
  Tabs,
  TextLink,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { useAssistant } from "./assistant/context";
import { PageInspection } from "./assistant/inspection-entry";
import type { ReactNode } from "react";
import { Narrative } from "./narrative";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { HistoryCoverage, PeriodSpan } from "./history-coverage";
import { portfolioRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { portfolioValueLines } from "./portfolio-value-lines";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { MoneyDrawdown, MoneySummary } from "./performance-money";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useRetainedResult } from "./retained-result";
import { DashboardRanges, InlineRetry, WaitingAsOf, rangeName } from "./dashboard-controls";
import { moneyTimelineLayout } from "./money-timeline-layout";

export function PerformanceWorkspace() {
  const t = useCopy();
  return <Page title={t("收益与风险", "Performance & risk")}><PerformanceContent /></Page>;
}
export function PerformanceContent({
  data: suppliedData,
  fixedScope,
}: {
  data?: DashboardLens;
  fixedScope?: Scope;
} = {}) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update: updateRoute } = useRouteState();
  const update = (values: Record<string, string | null>) => updateRoute({
    moneyFrom:null, moneyTo:null, inspectFrom:null, inspectTo:null, snapshotId:null, evidence:null, ...values,
  });
  const view =
    params.get("view") === "returns"
      ? "returns"
      : params.get("view") === "risk"
        ? "risk"
        : "money";
  const requestedScope: Scope =
    fixedScope ??
    (["invest", "isa", "household", "cfd"].includes(params.get("scope") ?? "")
      ? (params.get("scope") as Scope)
      : "total");
  const range = portfolioRange(params.get("range"));
  const preferredBenchmark = usePerformanceBenchmark();
  const benchmark = benchmarkValue(params.get("benchmark")) ?? preferredBenchmark;
  const {ready} = useAssistant();
  const [selectionRange,setSelectionRange] = useState<{start:string; end:string; identity:string} | null>(null);
  const [phoneRange,setPhoneRange] = useState<string | null>(null);
  const [moneyUnit, setMoneyUnit] = useState("gbp");
  const start = params.get("returnFrom"), end = params.get("returnTo");
  const customRange = view === "returns" && start && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start < end
    ? { start, end } : null;
  const requestedRange = view === "risk" || customRange ? "ALL" : view === "returns" && range === "1D" ? "3M" : range;
  const selection = useMemo(() => ({ range: requestedRange, scope: requestedScope, detail: "summary" as const }),
    [requestedRange, requestedScope]);
  // The account review lens supplies account history but no benchmark prices.
  const usesAnalytics = !suppliedData || view === "returns";
  const summary = useDashboardLens("analytics", undefined, usesAnalytics, selection);
  const incoming = usesAnalytics ? summary.data : suppliedData;
  // A cited GBP figure uses exactly the same prepared history, immutable publication and range as the tool.
  const moneyFrom = params.get("moneyFrom"), moneyTo = params.get("moneyTo"), citedId = params.get("snapshotId");
  const pinnedMoney = view === "money" && params.get("evidence") === "period_performance" &&
    moneyFrom && moneyTo && /^\d{4}-\d{2}-\d{2}$/.test(moneyFrom) && /^\d{4}-\d{2}-\d{2}$/.test(moneyTo) &&
    moneyFrom <= moneyTo && citedId && /^[a-zA-Z0-9_-]{1,100}$/.test(citedId) ? citedId : null;
  const historyId = pinnedMoney ?? incoming?.runId ?? "";
  const historyQuery = usePortfolioHistory({ runId: historyId, range: requestedRange, scope: requestedScope },
    view === "money" && Boolean(historyId));
  const runtime = useChartRuntime();
  // A single commit point: figures, dates, records and plots all consume this pair.
  // Neither half can overwrite a complete prior selection on its own.
  const current = useMemo(() => incoming && (view !== "money" || historyQuery.data) ? {
    data: incoming, history: historyQuery.data, range: requestedRange, scope: requestedScope,
    view, updatedAt: Math.max(summary.dataUpdatedAt, historyQuery.dataUpdatedAt),
  } : undefined, [incoming, historyQuery.data, historyQuery.dataUpdatedAt, requestedRange, requestedScope, summary.dataUpdatedAt, view]);
  const reading = useReadingBoundary();
  const retained = useRetainedResult(current, Object.is, (next, previous) => !reading.active ||
    next.view !== previous.view || next.range !== previous.range || next.scope !== previous.scope);
  const shown = retained?.view === view && retained.scope === requestedScope && (!pinnedMoney || retained.history?.runId === pinnedMoney) ? retained : undefined;
  const data = shown?.data;
  const scope = shown?.scope ?? requestedScope;
  const actualRange = shown?.range ?? requestedRange;
  const historySelection = { runId: shown?.history?.runId ?? data?.runId ?? "", range: actualRange, scope };
  const daily = useMemo(() => (data?.nav ?? []).filter((p) => !p.intraday), [data?.nav]);
  const failure = usesAnalytics && summary.isError ? summary : view === "money" && historyQuery.isError ? historyQuery : null;
  const publicationFailure = usePublicationFailure(suppliedData ? 0 : shown?.updatedAt ?? 0);
  const inlineFailure = failure && shown ? { updatedAt: shown.updatedAt, retry: failure.refetch } : publicationFailure;
  const waiting = !failure && !current || runtime.status === "loading";
  const rangeMismatch = shown && actualRange !== requestedRange;
  const rangeLabel = rangeName(requestedRange, t("全部", "all"));
  const waitingLabel = view === "risk"
    ? t("正在读取全部可用历史…", "Loading all available history…")
    : t("正在读取 ", "Loading ") + rangeLabel + t(" 记录…", " records…");
  const unavailable = runtime.status === "failed"
    ? { label: t("图表暂不可用", "Chart unavailable"), retry: runtime.retry }
    : failure && !shown ? {
      label: view === "money" ? t("盈亏记录暂不可用", "P&L history unavailable")
        : view === "returns" ? t("收益记录暂不可用", "Return history unavailable")
          : t("风险记录暂不可用", "Risk history unavailable"),
      retry: failure.refetch,
    } : null;
  const fallbackHistory = useMemo(() => selectPortfolioHistory({
    daily, intraday: data?.intradayNav, range: actualRange, scope,
    asOf: data?.brokerAsOf,
    requireCashFlows: view === "money",
  }), [daily, data?.intradayNav, actualRange, scope, data?.brokerAsOf, view]);
  const history = view === "money" ? shown?.history?.history ?? fallbackHistory : fallbackHistory;
  const isIntraday = view === "money" && history.source === "intraday";
  const availablePoints = view === "money" ? history.points : inRange(daily, actualRange).filter((p) =>
    navNumber(p, scope) != null && (!customRange || actualRange !== "ALL" || p.date >= customRange.start && p.date <= customRange.end));
  const allScope = [
    { value: "total", label: t("全部投资账户", "All investment accounts") },
    { value: "invest", label: accountName(profile, "A") },
    { value: "isa", label: accountName(profile, "B") },
  ];
  const scopeOptions =
    view === "money" && (incoming?.cfd || data?.cfd)
      ? [
          ...allScope,
          {
            value: "household",
            label: t("含 CFD 权益代理", "Including CFD proxy"),
          },
          { value: "cfd", label: "CFD" },
        ]
      : allScope;
  const invalidScope =
    view !== "money" && (requestedScope === "cfd" || requestedScope === "household");
  const comparison = view === "returns"
    ? benchmarkComparison(availablePoints, scope, data?.benchmarkSeries, benchmark === "ALL" ? ["VOO", "QQQ", "VT"] : [benchmark])
    : null;
  const returnsPoints = comparison?.points ?? [];
  const points = comparison?.points ?? availablePoints;
  const identity = [view,scope,actualRange,data?.runId,benchmark,start,end].join("|");
  const brush = ready ? (a:string,b:string) => {setPhoneRange(null); setSelectionRange({start:a,end:b,identity});} : undefined;
  const phoneIdentity = [view,scope,actualRange,data?.runId].join("|");
  const linkedFrom = params.get("inspectFrom"), linkedTo=params.get("inspectTo");
  const citedWindow = params.get("snapshotId")===data?.runId && linkedFrom && linkedTo && points.some(point=>point.date===linkedFrom) && points.some(point=>point.date===linkedTo) ? {start:linkedFrom,end:linkedTo} : null;
  const selectedWindow = selectionRange?.identity===identity ? selectionRange
    : phoneRange===phoneIdentity && points.length > 1 && !rangeMismatch ? {start:points[0].date,end:points.at(-1)!.date} : citedWindow;
  const inspection = <PageInspection role="attribution" snapshotId={data?.runId} object={selectedWindow ? selectedWindow.start.slice(0,10)+" – "+selectedWindow.end.slice(0,10) : t("所选区间","Selected range")}
    context={selectedWindow ? {scope:scope==="total"?"broker_total":scope,benchmark,view,range:actualRange,start:selectedWindow.start,end:selectedWindow.end} : undefined}
    onClose={() => {setSelectionRange(null);setPhoneRange(null);if (citedWindow) updateRoute({inspectFrom:null,inspectTo:null});}}/>;
  const first = points[0],
    last = points.at(-1);
  const money = view === "money" && shown?.history ? shown.history.money : portfolioMoney(points, scope);
  const twr =
    points.length > 1
      ? periodReturn(
          navNumber(first, scope, "Twr"),
          navNumber(last, scope, "Twr"),
        )
      : null;

  const returnLines: ChartLine[] = [
    {
      name: t("组合 TWR", "Portfolio TWR"),
      colour: "brand",
      area: true,
      values: returnsPoints.map((p) =>
        periodReturn(
          navNumber(returnsPoints[0], scope, "Twr"),
          navNumber(p, scope, "Twr"),
        ),
      ),
    },
    ...(comparison?.comparisons ?? []).map((entry, i): ChartLine => ({
      ...entry,
      colour: (["axis", "text", "axis"] as const)[i],
      dashed: true,
    })),
  ];
  const benchmarkEnd = returnLines.length === 2 ? returnLines[1].values.at(-1) : null;
  const spread = twr != null && benchmarkEnd != null ? Number(((twr - benchmarkEnd) * 100).toFixed(2)) || 0 : null;
  const moneyDrawdown = money.drawdown;
  const valueChanges = money.valueChanges;
  const valueChangePercents = money.valueChangePercents;
  const moneyDrawdownPercents = money.drawdownPercents;
  const periodPnls = money.pnls;
  const modelComparisons = points.map((point) => {
    if (scope === "invest") return point.investModelValueGbp ?? null;
    if (scope === "isa") return point.isaModelValueGbp ?? null;
    if (point.investModelValueGbp == null || point.isaModelValueGbp == null) return null;
    return point.investModelValueGbp + point.isaModelValueGbp + (scope === "household" ? history.carriedCfdValue ?? 0 : 0);
  });
  const returnDrawdowns = returnLines.map((line) => ({
    ...line,
    values: drawdowns(line.values, true),
    area: false,
  }));
  const returnDates = returnsPoints.map((point) => point.date);
  const returnEpisode = deepestDrawdown(returnDrawdowns[0].values);
  const timelineLayers: TimelineLayer[] = [
    ...(view === "money" ? [
      {
        label: t("区间净盈亏", "Period net P&L"),
        percentage: moneyUnit === "percent",
        zeroBaseline: true,
        markerDate: money.drawdownEpisode?.peak.date,
        lines: [{
          name: t("净盈亏", "Net P&L"),
          values: moneyUnit === "percent" ? money.pnlPercents : periodPnls,
          area: true,
        }],
      },
      {
        label: moneyUnit === "percent"
          ? t("价值与净入金变化", "Value & net deposit change")
          : t("账户价值与累计净入金", "Account value & cumulative net deposits"),
        percentage: moneyUnit === "percent",
        lines: portfolioValueLines(points, scope, t, moneyUnit === "percent"),
      },
    ] : [{ label: t("收益对比", "Return comparison"), lines: returnLines, percentage: true }]),
    {
      label: view === "money" ? t("盈亏回撤", "P&L drawdown") : t("期间回撤", "Period drawdown"),
      percentage: view === "returns" || moneyUnit === "percent",
      drawdown: true,
      markers: view === "money" ? [
        ...(money.drawdownEpisode ? [{ date: money.drawdownEpisode.trough.date, name: t("低点", "Trough") }] : []),
        ...(money.drawdownEpisode?.recovery ? [{ date: money.drawdownEpisode.recovery.date, name: t("恢复", "Recovery") }] : []),
      ] : drawdownMarks(returnEpisode, returnDates, t),
      lines:
        view === "returns"
          ? returnDrawdowns
          : [
              {
                name: t("盈亏回撤", "P&L drawdown"),
                values: moneyUnit === "percent" ? moneyDrawdownPercents : moneyDrawdown,
                colour: "negative",
                area: true,
              },
            ],
    },
  ];
  const percentUnit = moneyUnit === "percent";
  // Money: one leading figure, then the drawdown and the two value lines, each keyed to its stroke.
  // Returns: the pane being read leads; the comparison and, for returns, the difference follow.
  const timelineReading: TimelineReading = view === "returns"
    ? (row, { grid, key }) => {
        const pane = grid === 1 ? 1 : 0;
        return comparisonFigures((pane === 1 ? returnDrawdowns : returnLines).map((line, index) => ({
          item: {
            label: pane === 1 ? line.name + t(" 回撤", " drawdown") : line.name,
            key: key(pane, index),
            value: signedPercent(line.values[row]),
            tone: readingTone((line.values[row] ?? 0) * 100),
          },
          change: line.values[row],
        })), pane === 0 ? t("相差", "Difference") : undefined);
      }
    : moneyTimelineReading({
        pnls: periodPnls,
        pnlPercents: money.pnlPercents,
        drawdowns: moneyDrawdown,
        drawdownPercents: moneyDrawdownPercents,
        flows: money.periodFlows,
        valueLines: timelineLayers[1]?.lines ?? [],
        percentage: percentUnit,
        valueLayer: 1,
        t,
      });
  return (
    <ReadingBoundary.Provider value={reading.report}>
      <div className="mx-toolbar mx-analytics-toolbar">
        <Tabs
          label={t("绩效分析方式", "Performance perspective")}
          value={view}
          onChange={(v) =>
            update({
              view: v === "money" ? null : v,
              scope:
                v !== "money" && ["cfd", "household"].includes(requestedScope)
                  ? null
                  : requestedScope === "total"
                    ? null
                    : requestedScope,
            })
          }
          options={[
            { value: "money", label: t("资金与盈亏", "Money & P&L") },
            { value: "returns", label: t("收益对比", "Return comparison") },
            { value: "risk", label: t("风险诊断", "Risk profile") },
          ]}
        />
        <span className="mx-freshness-group">
          {(!data || runtime.status === "loading") && waiting ? <WaitingAsOf label={waitingLabel} /> : <Freshness date={data?.brokerAsOf} />}
          {view !== "money" && inlineFailure && <UpdateFailure {...inlineFailure} />}
        </span>
        <Select
          disabled={!!fixedScope}
          aria-label={t("分析账户", "Analysis account")}
          value={requestedScope}
          onChange={(v) => update({ scope: v === "total" ? null : v })}
          data={scopeOptions}
          w={200}
        />
      </div>
      {invalidScope ? (
        <Notice>
          {t(
            "请选择 Invest、ISA 或全部投资账户来分析收益和风险。",
            "Select Invest, ISA, or all investment accounts to analyse returns and risk.",
          )}
        </Notice>
      ) : view === "risk" ? (
        <div className="mx-data-body mx-performance-risk" aria-busy={waiting || undefined}>
          <RiskDashboard onBrush={brush} inspection={inspection} data={runtime.status === "ready" ? data : undefined} scope={scope}
            unavailable={unavailable} retry={usesAnalytics ? summary.refetch : undefined} />
        </div>
      ) : (
        <>
          <Panel className="mx-performance-chart">
            {ready && <h2 className="sr-only">{view === "money" ? t("资金与盈亏","Money and P&L") : t("收益对比","Return comparison")}</h2>}
            {/* The tab names the view; the chart's controls share one row. */}
            <div className="mx-toolbar mx-chart-toolbar">
              {view === "money" ? (
                <Segments
                  label={t("图表单位", "Chart units")}
                  value={moneyUnit}
                  onChange={setMoneyUnit}
                  options={[
                    { value: "gbp", label: "GBP" },
                    {
                      value: "percent",
                      label: t("占期初价值 %", "% of opening value"),
                    },
                  ]}
                />
              ) : (
                <Select
                  aria-label={t("基准", "Benchmark")}
                  value={benchmark}
                  onChange={(v) => { rememberBenchmark(v ?? "VOO"); update({ benchmark: v }); }}
                  allowDeselect={false}
                  data={[
                    { value: "VOO", label: "S&P 500 · VOO" },
                    { value: "QQQ", label: "Nasdaq 100 · QQQ" },
                    {
                      value: "VT",
                      label: t("全球股票 · VT", "Global equities · VT"),
                    },
                    { value: "ALL", label: t("全部基准", "All benchmarks") },
                  ]}
                  w={220}
                />
              )}
              <div className="mx-period-control">
                {runtime.status === "ready" && comparison && comparison.comparisons.length > 0
                  ? <span className="mx-comparison-basis">{t("共同区间", "Shared dates")} <PeriodSpan points={points} /></span>
                  : <PeriodSpan points={runtime.status === "ready" ? points : []} reserve />}
                <DashboardRanges value={requestedRange} onChange={(value) => {
                  if (ready && window.matchMedia("(max-width: 767px)").matches) {
                    setSelectionRange(null); setPhoneRange([view,scope,value,data?.runId].join("|"));
                  }
                  update({range:value,returnFrom:null,returnTo:null});
                }}
                  label={t("绩效区间", "Performance range")} intraday={view === "money"} />
              </div>
            </div>
            {unavailable ? <div className="mx-performance-unavailable"><InlineRetry {...unavailable} /></div>
              : !shown || runtime.status === "loading" ? <PerformancePending money={view === "money"} />
              : <div className="mx-data-body" aria-busy={waiting || undefined}>
            {rangeMismatch && <p className="mx-prior-range">
              {t("当前显示 ", "Showing ")}{rangeName(actualRange, t("全部", "all"))}
            </p>}
            {view === "money" && inlineFailure && <div className="mx-money-history-failure">
              <span>{t("盈亏记录", "P&L history")}</span><UpdateFailure {...inlineFailure} showRetry />
            </div>}
            {pinnedMoney && shown?.history && <p className="mx-return-range">{shown.history.history.startDay} – {shown.history.history.endDay} <button type="button" className="mx-text-link" onClick={() => update({})}>
              {t("返回当前记录", "Return to current history")}</button></p>}
            {view === "money" && <HistoryCoverage history={history} />}
            {view === "money" ? (
              <MoneySummary money={money} points={points} />
            ) : (
              <div className="mx-metric-grid mx-metric-lead mx-chart-metrics mx-return-reading">
                <Metric
                  large
                  label={t("组合 TWR", "Portfolio TWR")}
                  value={percent(twr, true, 2)}
                  tone={tone(twr)}
                  help={<>
                    <p>{t(
                      "TWR 剔除出入金的影响，与基准从共同起点比较。回撤从所选区间内的收益高点算起。",
                      "TWR removes the effect of deposits and withdrawals and starts from the same date as the benchmark. Drawdown is measured from the return high within the selected period.",
                    )}</p>
                    <DataBasis>{t(
                      "组合按日终账户价值计算时间加权收益；基准用同一天的收盘价，均以英镑计。",
                      "The portfolio uses time-weighted returns on end-of-day account values; benchmarks use closes on the same days, all in pounds.",
                    )}</DataBasis>
                  </>}
                />
                {comparison?.missing ? <InlineRetry
                  label={t("所选基准缺少共同记录", "Selected benchmark lacks shared records")} retry={summary.refetch} />
                  : spread != null && <div className="mx-return-comparator">
                    <span>{returnLines[1].name} <strong>{percent(benchmarkEnd, true, 2)}</strong></span>
                    <span>{t("相差", "Difference")} <strong>{spread > 0 ? "+" : ""}{spread.toFixed(2)} {t("个百分点", "pp")}</strong></span>
                  </div>}
              </div>
            )}
            {view === "money" && moneyUnit === "percent" && points.length > 0 && (navNumber(first, scope) ?? 0) <= 0 && (
              <Notice>{t("期初价值不大于零，无法显示百分比。请选择 GBP。", "Opening value is zero or negative. Select GBP to view amounts.")}</Notice>
            )}
              {view === "returns" && customRange && <div className="mx-return-range">
              <PeriodSpan points={points} /><button type="button" className="mx-text-link" onClick={() => update({ returnFrom: null, returnTo: null })}>
                {t("恢复上个区间", "Restore previous range")}
              </button>
            </div>}
              {view === "returns" && <Legend items={returnLines.map((line, i) => ({
                label: line.name, dashed: line.dashed,
                colour: ["var(--mx-brand)", "var(--mx-muted)", "var(--mx-ink)", "var(--mx-muted)"][i],
              }))} />}
              <TimelineChart
                onBrush={brush}
                fullscreen
                emptyHeadingLevel={2}
                dates={points.map((p) => p.date)}
                layers={timelineLayers}
                drawdownHeading={view === "money" ? <MoneyDrawdown money={money} /> : undefined}
                intraday={isIntraday}
                range={actualRange}
                timeline={view === "money" ? history.timeline : undefined}
                observations={view === "money" ? points : undefined}
                pendingCashFlows={view === "money" && history.pendingCashFlows}
                recordSource={view === "money" ? historySelection : undefined}
                reading={timelineReading}
                details={isIntraday ? [
                  { label: t("区间价值变化", "Value change"), values: valueChanges },
                  { label: t("相对期初", "From opening"), values: valueChangePercents, percentage: true },
                  ...(modelComparisons.some((value) => value != null) ? [{ label: t("同时段估算", "Estimate for this interval"), values: modelComparisons }] : []),
                ] : []}
                label={
                  view === "money"
                    ? t(
                        "盈亏、价值与回撤的同日对照",
                        "P&L, value and drawdown on a shared timeline",
                      )
                    : t(
                        "收益与回撤的同日对照",
                        "Returns and drawdowns on a shared timeline",
                      )
                }
              />
            {inspection}
            {view === "returns" && <DrawdownReading episode={returnEpisode} dates={returnDates} basis="selected" />}
            {view === "returns" && (
              <div className="mx-table-wrap mx-return-table" tabIndex={0} role="region" aria-label={t("收益与回撤对比", "Return and drawdown comparison")}>
                <table className="mx-table">
                  <thead>
                    <tr>
                      <th><span className="sr-only">{t("曲线", "Series")}</span></th>
                      <th className="mx-align-right">{t("区间收益", "Period return")}</th>
                      <th className="mx-align-right">{t("最大回撤", "Max drawdown")}</th>
                      <th className="mx-align-right">{t("期末回撤", "Ending drawdown")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returnLines.map((line, index) => {
                      const end = [...line.values].reverse().find((value) => value != null);
                      const drawdown = returnDrawdowns[index]?.values ?? [];
                      const maximumDrawdown = minimumObserved(drawdown);
                      return (
                        <tr key={line.name}>
                          <th>{line.name}</th>
                          <td className={"mx-align-right mx-" + tone(end)}>{percent(end, true, 2)}</td>
                          <td className={"mx-align-right mx-" + tone(maximumDrawdown)}>{percent(maximumDrawdown, false, 2)}</td>
                          <td className="mx-align-right">{percent([...drawdown].reverse().find((value) => value != null), false, 2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {(scope === "cfd" || scope === "household") && (
              <Notice tone="warn">
                {t(
                  "CFD 使用导入的已实现现金权益代理，不代表当前券商账户价值。",
                  "CFD values use an imported realised cash equity proxy, not the current broker account value.",
                )}{" "}
                {data?.cfd?.accountStatus === "retired" &&
                  t("该账户已停用。", "This account is retired.")}
              </Notice>
            )}
            </div>}
          </Panel>
          {view === "returns" && shown && runtime.status === "ready" && (
            <div className="mx-data-body" aria-busy={waiting || undefined}><ReturnGrid scope={scope} selected={customRange} onSelect={(period) => {
              update({ returnFrom: period.start, returnTo: period.end });
              document.querySelector(".mx-performance-chart")?.scrollIntoView({ block: "start" });
            }} /></div>
          )}
        </>
      )}
      {data && runtime.status === "ready" && <Narrative
        snapshot={data.runId}
        lens="return_attribution"
        page="analytics"
      />}
    </ReadingBoundary.Provider>
  );
}
function PerformancePending({ money }: { money: boolean }) {
  const t = useCopy();
  const phone = useMediaQuery("(max-width: 767px)");
  const narrow = useMediaQuery("(max-width: 375px)");
  const layout = money ? moneyTimelineLayout(!!phone, !!narrow) : {
    height: 550, grids: [{ top: 24, height: 225 }, { top: 277, height: 175 }],
  };
  return <>
    <div className={money ? "mx-money-summary" : "mx-chart-metrics"}>
      <Metric large label={money ? t("区间净盈亏", "Period net P&L") : t("组合 TWR", "Portfolio TWR")}
        value={<span className="mx-reading-placeholder" aria-hidden="true" />} />
      {money && <div className="mx-money-equation mx-equation-placeholder" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <span className="mx-reading-placeholder" key={index} />)}
      </div>}
    </div>
    <div className="mx-plot-placeholder" aria-hidden="true" style={{ height: layout.height }}>
      {layout.grids.map(({ top, height }) => <div key={top} style={{ top, height }}><Pending shape="chart" height={height} quiet /></div>)}
    </div>
  </>;
}

function RiskReadings({ rows, scope, pending }: { rows: NavPoint[]; scope: Scope; pending: boolean }) {
  const t = useCopy();
  const { locale } = useLocale();
  const values = rows.map((point) => navNumber(point, scope, "Drawdown"));
  const current = values.at(-1);
  const maximum = minimumObserved(values);
  const bottom = maximum == null || maximum >= 0 ? -1 : values.indexOf(maximum);
  let peak: NavPoint | undefined;
  let peakValue = -Infinity;
  for (let i = 0; i < bottom; i++) {
    const reading = navNumber(rows[i], scope, "Twr");
    if (reading != null && reading >= peakValue) {
      peak = rows[i];
      peakValue = reading;
    }
  }
  const date = (point: NavPoint) => formatDate(point.date, locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const placeholder = <span className="mx-reading-placeholder" aria-hidden="true" />;
  return <div className="mx-risk-readings">
    <Metric large label={t("当前回撤", "Current drawdown")}
      value={pending ? placeholder : percent(current, false, 2)} tone={tone(current)} />
    <Metric label={t("最大回撤", "Max drawdown")}
      value={pending ? placeholder : percent(maximum, false, 2)} tone={tone(maximum)}
      note={peak ? <span className="mx-risk-drawdown-episode">
        {t("高点 ", "Peak ")}<time dateTime={peak.date}>{date(peak)}</time>
        <span aria-hidden="true"> → </span>
        {t("低点 ", "Trough ")}<time dateTime={rows[bottom].date}>{date(rows[bottom])}</time>
      </span> : undefined} />
  </div>;
}

function RiskDashboard({ data, scope, unavailable, retry, onBrush, inspection }: {
  onBrush?: (start:string,end:string)=>void;
  inspection:ReactNode;
  data?: DashboardLens;
  scope: Scope;
  unavailable: { label: string; retry: () => unknown } | null;
  retry?: () => unknown;
}) {
  const t = useCopy();
  const rows = inRange(data?.nav?.filter((p) => !p.intraday) ?? [], "ALL");
  const dates = rows.map((point) => point.date);
  const drawdown = rows.map((point) => navNumber(point, scope, "Drawdown"));
  const episode = deepestDrawdown(drawdown);
  return (
    <>
      <Panel
        title={t("历史收益回撤", "Historical return drawdown")}
        help={<>
          <p>{t("收益相对历史高点的回落幅度，使用全部可用历史。", "Return decline from the previous high across the full available history.")}</p>
          <DataBasis>{t(
            "组合按日终账户价值计算时间加权收益，以英镑计；不使用盘中记录。",
            "Time-weighted returns on end-of-day account values, in pounds; intraday records are not used.",
          )}</DataBasis>
        </>}
        action={<span className="mx-risk-basis">{onBrush && dates.length>1 && <button className="mx-range-inspect-mobile" onClick={()=>onBrush(dates[0],dates.at(-1)!)}>{t("解读区间","Read range")}</button>}{t("全部可用历史", "All available history")} <PeriodSpan points={rows} /></span>}
      >
        <RiskReadings rows={rows} scope={scope} pending={!data && !unavailable} />
        {unavailable ? <div className="mx-performance-unavailable"><InlineRetry {...unavailable} /></div>
          : !data ? <Pending shape="chart" height={260} quiet />
          : <HistoryChart onBrush={onBrush}
          fullscreen
          label={t("收益回撤曲线", "Portfolio return drawdown")}
          dates={dates}
          lines={[
            {
              name: t("回撤", "Drawdown"),
              values: drawdown,
              markers: drawdownMarks(episode, dates, t),
              colour: "negative",
              area: true,
            },
          ]}
          percentage
          height={260}
        />}
        {inspection}
        {data && <DrawdownReading episode={episode} dates={dates} basis="all" />}
      </Panel>
      {data && <div className="mx-grid">
        {(["A", "B"] as const)
          .filter(
            (code) =>
              scope === "total" ||
              (scope === "invest" ? code === "A" : code === "B"),
          )
          .map((code) => (
            <RiskCard
              key={code}
              metrics={
                data.risk?.[code] ??
                (data.selectedAccount?.code === code
                  ? (data.selectedRisk ?? undefined)
                  : undefined)
              }
              code={code}
              retry={retry}
            />
          ))}
      </div>}
    </>
  );
}
function RiskCard({
  metrics,
  code,
  retry,
}: {
  metrics?: RiskMetrics;
  code: "A" | "B";
  retry?: () => unknown;
}) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  return (
    <Panel
      title={accountName(profile, code)}
      help={t(
        "指标基于完整可用历史。Sharpe 同时考虑上下波动；Sortino 侧重下行风险。缺失指标表示数据不足，不等于零风险。",
        "Metrics use the full available history. Sharpe accounts for all volatility; Sortino focuses on downside risk. Missing metrics indicate insufficient data, not zero risk.",
      )}
      action={
        <TextLink href={"/review?account=" + code}>
          {t("复盘账户", "Review account")}
        </TextLink>
      }
    >
      {metrics ? (
        <>
          <div
            className="mx-metric-grid"
            style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}
          >
            <Metric
              label={t("最大回撤", "Max drawdown")}
              value={percent(metrics.maxDrawdown)}
              tone="down"
            />
            <Metric
              label={t("年化波动率", "Annualised volatility")}
              value={percent(metrics.volatility)}
            />
          </div>
          <Facts
            rows={[
              [
                t("时间加权收益", "Time-weighted return"),
                percent(metrics.twr, true),
              ],
              [
                t("年化收益", "Annualised return"),
                percent(metrics.annualizedReturn, true),
              ],
              [
                t("当前回撤", "Current drawdown"),
                percent(metrics.currentDrawdown),
              ],
              ["Sharpe", number(metrics.sharpe)],
              ["Sortino", number(metrics.sortino)],
              ["Calmar", number(metrics.calmar)],
              [
                t("信息比率", "Information ratio") + (metrics.benchmark ? " · " + metrics.benchmark : ""),
                number(metrics.informationRatio),
              ],
            ]}
          />
        </>
      ) : retry ? (
        <InlineRetry label={t("账户风险指标暂不可用", "Account risk metrics unavailable")} retry={retry} />
      ) : <Empty title={t("风险数据暂不可用", "Risk metrics unavailable")} />}
    </Panel>
  );
}
