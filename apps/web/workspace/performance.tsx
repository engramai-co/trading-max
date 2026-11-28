"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useBreakpoint } from "@/lib/hooks";
import { deepestDrawdown } from "@/lib/portfolio/drawdown-episodes";
import { ReturnGrid } from "./performance-return-grid";
import { DrawdownReading, drawdownMarks } from "./drawdown-reading";
import { minimumObserved } from "@/lib/portfolio/math";
import { useCallback, useMemo, useRef, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { useLocale } from "@/components/locale-provider";
import { formatDate, formatDateTime } from "@/ui/formatters";
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
  ReadStatus,
  Segments,
  TabPanel,
  Tabs,
  TabsScope,
  TextLink,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { useAssistant, useAssistantPageContext } from "./assistant/context";
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
import { CitedMoneyAmount, MoneyDrawdown, MoneySummary, citedMoneyAmount, moneyEquationClassName } from "./performance-money";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useChartColours } from "@/ui/charts/palette";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { ALL_BENCHMARKS, returnComparisonLayers, returnComparisonLines, returnDrawdownLines, returnLegendItems } from "./performance-return-lines";
import { useRetainedResult } from "./retained-result";
import { DashboardRanges, InlineRetry, WaitingAsOf, rangeName } from "./dashboard-controls";
import { moneyTimelineLayout } from "./money-timeline-layout";
import { SelectPicker } from "./picker";

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
    moneyFrom:null, moneyTo:null, inspectFrom:null, inspectTo:null, snapshotId:null, evidence:null, field:null, record:null, ...values,
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
  const {locale, timeZone} = useLocale();
  const [selectionRange,setSelectionRange] = useState<{start:string; end:string; identity:string; snapshotId:string} | null>(null);
  const rangeTrigger = useRef<HTMLElement>(null);
  const riskTab = useRef<HTMLButtonElement>(null);
  const chartToolbar = useRef<HTMLDivElement>(null);
  const periodTrigger = useRef<HTMLElement>(null);
  const bindRiskRangeTrigger = useCallback((button: HTMLElement | null) => {
    // An updated history can remove Read range while its reading sheet is open.
    rangeTrigger.current = button ?? riskTab.current;
  }, []);
  const [phoneRange,setPhoneRange] = useState<string | null>(null);
  const [moneyUnit, setMoneyUnit] = useState("gbp");
  const linkedFrom = params.get("inspectFrom"), linkedTo = params.get("inspectTo");
  const showRecord = params.get("record") === "1";
  const start = params.get("returnFrom") ?? (showRecord ? linkedFrom : null);
  const end = params.get("returnTo") ?? (showRecord ? linkedTo : null);
  const customRange = view === "returns" && start && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start < end
    ? { start, end } : null;
  const restoreRange = () => {
    update({ returnFrom: null, returnTo: null });
    const trigger = periodTrigger.current;
    periodTrigger.current = null;
    if (trigger?.isConnected) trigger.focus();
    else chartToolbar.current?.focus({ preventScroll: true });
  };
  const requestedRange = view === "risk" || customRange ? "ALL" : view === "returns" && range === "1D" ? "3M" : range;
  const citedId = params.get("snapshotId");
  const inspectionCitation = Boolean(citedId && linkedFrom && linkedTo);
  const pinnedLens = view !== "money" && (inspectionCitation || (view === "returns" && params.get("evidence") === "compare_benchmarks"))
    ? citedId || undefined : undefined;
  const moneyFrom = params.get("moneyFrom"), moneyTo = params.get("moneyTo");
  const moneyCitation = params.get("evidence") === "period_performance" &&
    moneyFrom && moneyTo && /^\d{4}-\d{2}-\d{2}$/.test(moneyFrom) && /^\d{4}-\d{2}-\d{2}$/.test(moneyTo) && moneyFrom <= moneyTo;
  const pinnedMoney = view === "money" && (inspectionCitation || moneyCitation) ? citedId : null;
  const retainedRisk = Boolean(pinnedLens && view === "risk");
  const selection = useMemo(() => ({range:requestedRange, scope:requestedScope, detail:"summary" as const,
    ...(retainedRisk ? {projection:"risk" as const} : {})}), [requestedRange, requestedScope, retainedRisk]);
  const usesAnalytics = !pinnedMoney && (!suppliedData || view === "returns" || Boolean(pinnedLens));
  const summary = useDashboardLens("analytics", undefined, usesAnalytics, selection, pinnedLens);
  const incoming = usesAnalytics ? summary.data : suppliedData;
  const historyId = pinnedMoney ?? incoming?.runId ?? "";
  const historyQuery = usePortfolioHistory({ runId: historyId, range: requestedRange, scope: requestedScope },
    view === "money" && Boolean(historyId), [], Boolean(pinnedMoney));
  const citedMoneyField = pinnedMoney && moneyCitation ? params.get("field") : null;
  const wrongMoneyRecord = Boolean(pinnedMoney && historyQuery.data && (historyQuery.data.runId !== pinnedMoney ||
    (citedMoneyField && (historyQuery.data.history.startDay !== moneyFrom || historyQuery.data.history.endDay !== moneyTo ||
      citedMoneyAmount(historyQuery.data.money, citedMoneyField) == null))));
  const runtime = useChartRuntime();
  const colours = useChartColours();
  // A single commit point: figures, dates, records and plots all consume this pair.
  // Neither half can overwrite a complete prior selection on its own.
  const current = useMemo(() => (incoming || pinnedMoney) && (view !== "money" || historyQuery.data) ? {
    data: incoming, history: historyQuery.data, range: requestedRange, scope: requestedScope,
    view, updatedAt: Math.max(summary.dataUpdatedAt, historyQuery.dataUpdatedAt),
  } : undefined, [incoming, pinnedMoney, historyQuery.data, historyQuery.dataUpdatedAt, requestedRange, requestedScope, summary.dataUpdatedAt, view]);
  const reading = useReadingBoundary();
  const identity = [view,requestedScope,requestedRange,benchmark,start,end,citedId,linkedFrom,linkedTo].join("|");
  if (selectionRange && selectionRange.identity !== identity) setSelectionRange(null);
  const activeRange = ready && selectionRange?.identity === identity ? selectionRange : null;
  const publicationOf = (chart: NonNullable<typeof current>) => chart.view === "money" ? chart.history?.runId : chart.data?.runId;
  const retained = useRetainedResult(current, Object.is, (next, previous) =>
    (!activeRange || publicationOf(next) === activeRange.snapshotId) &&
    (!reading.active || next.data?.runId === pinnedLens || next.view !== previous.view || next.range !== previous.range || next.scope !== previous.scope));
  const shown = retained?.view === view && retained.scope === requestedScope &&
    (!pinnedLens || (!summary.isFetching && !summary.isError && retained.data?.runId === pinnedLens)) &&
    (!pinnedMoney || (!historyQuery.isFetching && !historyQuery.isError && !wrongMoneyRecord && retained.history?.runId === pinnedMoney)) ? retained : undefined;
  const data = shown?.data;
  const scope = shown?.scope ?? requestedScope;
  const actualRange = shown?.range ?? requestedRange;
  const historySelection = { runId: shown?.history?.runId ?? data?.runId ?? "", range: actualRange, scope };
  const shownWindow = actualRange === "ALL" ? customRange : null;
  useAssistantPageContext({
    page: "analytics",
    scope: scope === "total" ? "broker_total" : scope,
    range: actualRange,
    start: shownWindow?.start,
    end: shownWindow?.end,
    benchmark: view === "returns" ? benchmark : undefined,
    snapshotId: historySelection.runId || undefined,
  }, fixedScope === undefined);
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
  const unavailable = wrongMoneyRecord ? { label:t("引用的记录暂不可用", "Cited record unavailable"), retry:historyQuery.refetch }
    : runtime.status === "failed"
    ? { label: t("图表暂不可用", "Chart unavailable"), retry: runtime.retry }
    : failure && !shown ? {
      label: pinnedLens || pinnedMoney ? t("引用的数据版本暂不可用", "Cited publication unavailable")
        : view === "money" ? t("盈亏记录暂不可用", "P&L history unavailable")
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
  const rangeStart = customRange?.start, rangeEnd = customRange?.end;
  const availablePoints = useMemo(() => view === "money" ? history.points : inRange(daily, actualRange).filter((p) =>
    navNumber(p, scope) != null && (!rangeStart || !rangeEnd || actualRange !== "ALL" || p.date >= rangeStart && p.date <= rangeEnd)),
  [view, history.points, daily, actualRange, scope, rangeStart, rangeEnd]);
  const allScope = [
    { value: "total", label: t("全部投资账户", "All investment accounts") },
    { value: "invest", label: accountName(profile, "A") },
    { value: "isa", label: accountName(profile, "B") },
  ];
  const scopeOptions =
    view === "money" && (incoming?.cfd || data?.cfd || requestedScope === "household" || requestedScope === "cfd")
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
  const comparison = useMemo(() => view === "returns"
    ? benchmarkComparison(availablePoints, scope, data?.benchmarkSeries, benchmark === "ALL" ? ALL_BENCHMARKS : [benchmark])
    : null, [view, availablePoints, scope, data?.benchmarkSeries, benchmark]);
  const returnsPoints = comparison?.points;
  const points = returnsPoints ?? availablePoints;
  const chartWindowReady = runtime.status === "ready" && !rangeMismatch && points.length > 0;
  const toolbarDates = customRange && !chartWindowReady ? [{ date: customRange.start }, { date: customRange.end }]
    : runtime.status === "ready" ? points : [];
  const plottedDates = useMemo(() => points.map((point) => point.date), [points]);
  const readingReady = !!shown && runtime.status === "ready" && !unavailable;
  const benchmarkUnavailable = t("所选基准缺少共同记录", "Selected benchmark lacks shared records");
  const plottedId = shown && publicationOf(shown);
  const brush = ready && plottedId && !rangeMismatch ? (a:string,b:string) => {
    setPhoneRange(null);
    setSelectionRange({start:a,end:b,identity,snapshotId:plottedId});
  } : undefined;
  const phoneIdentity = [view,requestedScope,requestedRange].join("|");
  if (phoneRange === phoneIdentity && plottedId && !rangeMismatch && points.length > 1) {
    setSelectionRange({start:points[0].date,end:points.at(-1)!.date,identity,snapshotId:plottedId});
    setPhoneRange(null);
  }

  const citedWindow = citedId && citedId===plottedId && linkedFrom && linkedTo
    ? {start:linkedFrom,end:linkedTo,snapshotId:citedId} : null;
  const [followedWindow, setFollowedWindow] = useState("");
  const recordOnly = showRecord || followedWindow === identity;
  const selectedWindow = activeRange ?? (followedWindow === identity && !showRecord ? null : citedWindow);
  const endpointsPresent = selectedWindow && points.some(p=>p.date===selectedWindow.start) && points.some(p=>p.date===selectedWindow.end);
  const endpointLabel = (value:string) => value.length===10 ? value : formatDateTime(value,locale,timeZone);
  const newestId = current && publicationOf(current);
  const inspection = <PageInspection key={selectedWindow?.snapshotId} role="attribution" showInline={recordOnly && !activeRange}
      returnFocusRef={activeRange ? rangeTrigger : undefined}
      unavailable={Boolean(selectedWindow && !endpointsPresent && shown)}
      snapshotId={selectedWindow?.snapshotId ?? plottedId} object={selectedWindow ? endpointLabel(selectedWindow.start)+" – "+endpointLabel(selectedWindow.end) : t("所选区间","Selected range")}
      context={selectedWindow ? {scope:scope==="total"?"broker_total":scope,benchmark,view,range:actualRange,start:selectedWindow.start,end:selectedWindow.end} : undefined}
      onUpdate={activeRange && newestId && activeRange.snapshotId !== newestId ? () => setSelectionRange({...activeRange,snapshotId:newestId}) : undefined}
      onFollowCitation={() => {setSelectionRange(null); setPhoneRange(null); setFollowedWindow(identity);}}
      onClose={() => {setSelectionRange(null);setPhoneRange(null);if (citedWindow && !showRecord) updateRoute({inspectFrom:null,inspectTo:null});}}/>;
  const first = points[0],
    last = points.at(-1);
  const publishedMoney = view === "money" ? shown?.history?.money : undefined;
  const money = useMemo(() => publishedMoney ?? portfolioMoney(points, scope), [publishedMoney, points, scope]);
  const twr =
    points.length > 1
      ? periodReturn(
          navNumber(first, scope, "Twr"),
          navNumber(last, scope, "Twr"),
        )
      : null;

  const returnLines: ChartLine[] = useMemo(() => returnComparisonLines(
    returnsPoints ?? [],
    scope,
    comparison?.comparisons ?? [],
    t("组合 TWR", "Portfolio TWR"),
  ), [returnsPoints, scope, comparison, t]);
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
  const returnDrawdowns = useMemo(() => returnDrawdownLines(returnLines), [returnLines]);
  const returnDates = useMemo(() => returnsPoints?.map((point) => point.date) ?? [], [returnsPoints]);
  const returnEpisode = useMemo(() => deepestDrawdown(returnDrawdowns[0].values), [returnDrawdowns]);
  const timelineLayers: TimelineLayer[] = useMemo(() => view === "money" ? [
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
    {
      label: t("盈亏回撤", "P&L drawdown"),
      percentage: moneyUnit === "percent",
      drawdown: true,
      markers: [
        ...(money.drawdownEpisode ? [{ date: money.drawdownEpisode.trough.date, name: t("低点", "Trough") }] : []),
        ...(money.drawdownEpisode?.recovery ? [{ date: money.drawdownEpisode.recovery.date, name: t("恢复", "Recovery") }] : []),
      ],
      lines: [{
        name: t("盈亏回撤", "P&L drawdown"),
        values: moneyUnit === "percent" ? moneyDrawdownPercents : moneyDrawdown,
        colour: "negative",
        area: true,
      }],
    },
  ] : returnComparisonLayers(
    returnLines,
    { returns: t("收益对比", "Return comparison"), drawdown: t("期间回撤", "Period drawdown") },
    drawdownMarks(returnEpisode, returnDates, t),
    returnDrawdowns,
  ), [view, t, moneyUnit, money, periodPnls, points, scope, moneyDrawdownPercents, moneyDrawdown, returnLines, returnEpisode, returnDates, returnDrawdowns]);
  const percentUnit = moneyUnit === "percent";
  // Money: one leading figure, then the drawdown and the two value lines, each keyed to its stroke.
  // Returns: the pane being read leads; the comparison and, for returns, the difference follow.
  const timelineReading: TimelineReading = useMemo(() => view === "returns"
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
      }), [view, returnDrawdowns, returnLines, t, periodPnls, money.pnlPercents, moneyDrawdown,
        moneyDrawdownPercents, money.periodFlows, timelineLayers, percentUnit]);
  return (
    <ReadingBoundary.Provider value={reading.report}>
      <TabsScope value={view} onChange={(v) =>
            update({
              view: v === "money" ? null : v,
              scope:
                v !== "money" && ["cfd", "household"].includes(requestedScope)
                  ? null
                  : requestedScope === "total"
                    ? null
                    : requestedScope,
            })
          }>
      <div className="mx-toolbar mx-analytics-toolbar">
        <Tabs
          label={t("绩效分析方式", "Performance perspective")}
          value={view}
          options={[
            { value: "money", label: t("资金与盈亏", "Money & P&L") },
            { value: "returns", label: t("收益对比", "Return comparison") },
            { value: "risk", label: t("风险诊断", "Risk profile"), ref: riskTab },
          ]}
        />
        <span className="mx-freshness-group">
          {(!data || runtime.status === "loading") && waiting ? <WaitingAsOf label={waitingLabel} /> : <Freshness date={shown?.history?.brokerAsOf ?? data?.brokerAsOf} />}
          {view !== "money" && inlineFailure && <UpdateFailure {...inlineFailure} />}
        </span>
        <SelectPicker
          disabled={!!fixedScope}
          aria-label={t("分析账户", "Analysis account")}
          value={requestedScope}
          onChange={(v) => update({ scope: v === "total" ? null : v })}
          options={scopeOptions}
          intrinsic
        />
      </div>
      <TabPanel value={view}>
      {!invalidScope && <>
        <ReadStatus key={view + requestedScope} failure={unavailable?.label}
          ready={readingReady} recovered={t("绩效记录已恢复。", "Performance records are available again.")} />
        {comparison && <ReadStatus key={benchmark + requestedScope}
          failure={readingReady && comparison.missing ? benchmarkUnavailable : undefined} ready={readingReady && !comparison.missing}
          recovered={t("基准共同记录已恢复。", "Shared benchmark records are available again.")} />}
      </>}
      {invalidScope ? (
        <Notice>
          {t(
            "请选择 Invest、ISA 或全部投资账户来分析收益和风险。",
            "Select Invest, ISA, or all investment accounts to analyse returns and risk.",
          )}
        </Notice>
      ) : view === "risk" ? (
        <div className="mx-data-body mx-performance-risk grid gap-[inherit]" data-citation-ready={Boolean(shown && !waiting) || undefined} aria-busy={waiting || undefined}>
          <RiskDashboard onBrush={brush} rangeTrigger={bindRiskRangeTrigger} inspection={inspection} data={runtime.status === "ready" ? data : undefined} scope={scope}
            unavailable={unavailable} retry={usesAnalytics ? summary.refetch : undefined} />
        </div>
      ) : (
        <>
          <Panel className="mx-performance-chart [scroll-margin-block-start:var(--shell-anchor-gap)]">
            {ready && <h2 className="sr-only" data-citation-ready={Boolean(shown && !waiting) || undefined}>{view === "money" ? t("资金与盈亏","Money and P&L") : t("收益对比","Return comparison")}</h2>}
            {/* The tab names the view; the chart's controls share one row. */}
            <div className="mx-toolbar mx-chart-toolbar rounded-xl focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]"
              ref={chartToolbar} tabIndex={view === "returns" ? -1 : undefined}
              role={view === "returns" ? "group" : undefined} aria-label={view === "returns" ? t("收益对比", "Return comparison") : undefined}>
              {view === "money" ? (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 max-phone:gap-x-1">
                  <span className="text-xs text-muted-foreground" aria-hidden="true">{t("图表单位", "Chart units")}</span>
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
                </div>
              ) : (
                <SelectPicker
                  aria-label={t("基准", "Benchmark")}
                  value={benchmark}
                  onChange={(v) => { rememberBenchmark(v ?? "VOO"); update({ benchmark: v }); }}
                  options={[
                    { value: "VOO", label: "S&P 500 · VOO" },
                    { value: "QQQ", label: "Nasdaq 100 · QQQ" },
                    {
                      value: "VT",
                      label: t("全球股票 · VT", "Global equities · VT"),
                    },
                    { value: "ALL", label: t("全部基准", "All benchmarks") },
                  ]}
                  style={{ width: 220 }}
                />
              )}
              <div className="mx-period-control max-phone:w-full max-phone:[&>.mx-dashboard-ranges]:w-full" onClickCapture={event => {
                const button = event.target instanceof Element ? event.target.closest("button") : null;
                // The More menu is portalled. Keep its persistent opener when a menu item is chosen.
                if (button && event.currentTarget.contains(button)) rangeTrigger.current = button;
              }}>
                <div className={customRange ? "flex flex-wrap items-baseline gap-x-2" : "contents"}>
                  {runtime.status === "ready" && comparison && comparison.comparisons.length > 0 && (!customRange || chartWindowReady)
                    ? <span className="mx-comparison-basis flex flex-wrap items-baseline gap-x-2 text-[0.75rem] text-muted-foreground">{t("共同区间", "Shared dates")} <PeriodSpan points={points} /></span>
                    : <PeriodSpan points={toolbarDates} reserve />}
                  {customRange && <Button type="button" variant="link" className="px-2 text-xs" onClick={restoreRange}>
                    {t("恢复上个区间", "Restore previous range")}
                  </Button>}
                </div>
                <DashboardRanges value={requestedRange} custom={Boolean(customRange)} onChange={(value) => {
                  periodTrigger.current = null;
                  if (ready && window.matchMedia(MEDIA_QUERIES.phone).matches) {
                    setSelectionRange(null); setPhoneRange([view,requestedScope,value].join("|"));
                  }
                  update({range:value,returnFrom:null,returnTo:null});
                }}
                  label={t("绩效区间", "Performance range")} intraday={view === "money"} />
              </div>
            </div>
            {unavailable ? <div className="mx-performance-unavailable grid min-h-[260px] content-center"><InlineRetry {...unavailable} /></div>
              : !shown || runtime.status === "loading" ? <PerformancePending money={view === "money"} />
              : <div className="mx-data-body" aria-busy={waiting || undefined}>
            {rangeMismatch && <p className="mx-prior-range">
              {t("当前显示 ", "Showing ")}{rangeName(actualRange, t("全部", "all"))}
            </p>}
            {view === "money" && inlineFailure && <div className="mx-money-history-failure mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.75rem] text-muted-foreground max-phone:[&_.mx-update-failure]:min-h-11">
              <span>{t("盈亏记录", "P&L history")}</span><UpdateFailure {...inlineFailure} showRetry />
            </div>}
            {pinnedMoney && shown?.history && <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-[0.8125rem]">{shown.history.history.startDay} – {shown.history.history.endDay} <Button type="button" variant="link" className="px-0 text-xs" onClick={() => update({})}>
              {t("返回当前记录", "Return to current history")}</Button></div>}
            {view === "money" && <HistoryCoverage history={history} />}
            {citedMoneyField && <CitedMoneyAmount money={money} field={citedMoneyField} />}
            {view === "money" ? (
              <MoneySummary money={money} points={points} />
            ) : (
              <div className="mx-metric-grid mx-metric-lead mx-chart-metrics mx-return-reading min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-end max-phone:grid-cols-1 phone:[&>:is(.mx-return-comparator,.mx-retry-reading)]:pb-2">
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
                  label={benchmarkUnavailable} retry={summary.refetch} />
                  : spread != null && <div className="mx-return-comparator flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 text-[0.75rem] text-muted-foreground tabular-nums">
                    <span>{returnLines[1].name} <strong className="text-foreground">{percent(benchmarkEnd, true, 2)}</strong></span>
                    <span>{t("相差", "Difference")} <strong className="text-foreground">{spread > 0 ? "+" : ""}{spread.toFixed(2)} {t("个百分点", "pp")}</strong></span>
                  </div>}
              </div>
            )}
            {view === "money" && moneyUnit === "percent" && points.length > 0 && (navNumber(first, scope) ?? 0) <= 0 && (
              <Notice>{t("期初价值不大于零，无法显示百分比。请选择 GBP。", "Opening value is zero or negative. Select GBP to view amounts.")}</Notice>
            )}
              {view === "returns" && <Legend items={returnLegendItems(returnLines, colours)} />}
              <TimelineChart
                onBrush={brush}
                fullscreen
                emptyHeadingLevel={2}
                dates={plottedDates}
                keyboardPanes={view === "returns" ? [t("收益", "Returns"), t("回撤", "Drawdown")] : undefined}
                layers={timelineLayers}
                drawdownHeading={view === "money" ? <MoneyDrawdown money={money} /> : undefined}
                intraday={isIntraday}
                range={actualRange}
                timeline={view === "money" ? history.timeline : undefined}
                observations={view === "money" ? points : undefined}
                pendingCashFlows={view === "money" && history.pendingCashFlows}
                recordSource={view === "money" ? historySelection : undefined}
                retainedRecords={Boolean(pinnedMoney)}
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
              <Table containerProps={{ className: "mx-table-wrap mx-return-table" }} label={t("收益与回撤对比", "Return and drawdown comparison")} className="mx-table">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col"><span className="sr-only">{t("曲线", "Series")}</span></TableHead>
                    <TableHead scope="col" className="mx-align-right">{t("区间收益", "Period return")}</TableHead>
                    <TableHead scope="col" className="mx-align-right">{t("最大回撤", "Max drawdown")}</TableHead>
                    <TableHead scope="col" className="mx-align-right">{t("期末回撤", "Ending drawdown")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {returnLines.map((line, index) => {
                    const end = line.values.findLast((value) => value != null);
                    const drawdown = returnDrawdowns[index]?.values ?? [];
                    const maximumDrawdown = minimumObserved(drawdown);
                    return (
                      <TableRow key={line.name}>
                        <TableHead scope="row">{line.name}</TableHead>
                        <TableCell className={"mx-align-right mx-" + tone(end)}>{percent(end, true, 2)}</TableCell>
                        <TableCell className={"mx-align-right mx-" + tone(maximumDrawdown)}>{percent(maximumDrawdown, false, 2)}</TableCell>
                        <TableCell className="mx-align-right">{percent(drawdown.findLast((value) => value != null), false, 2)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
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
            <div className="mx-data-body" aria-busy={waiting || undefined}><ReturnGrid runId={pinnedLens} scope={scope} selected={customRange} onSelect={(period, trigger) => {
              update({ returnFrom: period.start, returnTo: period.end });
              periodTrigger.current = trigger;
              const toolbar = chartToolbar.current;
              toolbar?.focus({ preventScroll: true });
              toolbar?.closest(".mx-performance-chart")?.scrollIntoView({ block: "start" });
            }} /></div>
          )}
        </>
      )}
      </TabPanel>
      </TabsScope>
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
  const phone = useBreakpoint("phone");
  const narrow = useBreakpoint("narrow");
  const layout = money ? moneyTimelineLayout(!!phone, !!narrow) : {
    height: 550, grids: [{ top: 24, height: 225 }, { top: 277, height: 175 }],
  };
  return <>
    <div className={money ? "mx-money-summary" : "mx-chart-metrics"}>
      <Metric large label={money ? t("区间净盈亏", "Period net P&L") : t("组合 TWR", "Portfolio TWR")}
        value={<Skeleton as="span" className="mx-reading-placeholder" />} />
      {money && <div className={moneyEquationClassName} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <Skeleton as="span" className="mx-reading-placeholder my-2 ml-auto w-[min(100%,9ch)] max-phone:my-0.5" key={index} />)}
      </div>}
    </div>
    <div className="mx-plot-placeholder relative" aria-hidden="true" style={{ height: layout.height }}>
      {layout.grids.map(({ top, height }) => <div className="absolute start-12 end-2 [&_.mx-loading]:min-h-0" key={top} style={{ top, height }}><Pending shape="chart" height={height} quiet /></div>)}
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
  const placeholder = <Skeleton as="span" className="mx-reading-placeholder" />;
  return <div className="mx-risk-readings mb-4 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-start gap-7 max-phone:gap-(--mx-space-items) [&_.mx-metric:not(.mx-metric-large)_.mx-number]:text-[1.5rem] max-phone:[&_.mx-metric:not(.mx-metric-large)_.mx-number]:text-(length:--mx-text-metric)">
    <Metric large label={t("当前回撤", "Current drawdown")}
      value={pending ? placeholder : percent(current, false, 2)} tone={tone(current)} />
    <Metric label={t("最大回撤", "Max drawdown")}
      value={pending ? placeholder : percent(maximum, false, 2)} tone={tone(maximum)}
      note={peak ? <span className="mx-risk-drawdown-episode text-[0.75rem] text-muted-foreground [&_time]:whitespace-nowrap">
        {t("高点 ", "Peak ")}<time dateTime={peak.date}>{date(peak)}</time>
        <span aria-hidden="true"> → </span>
        {t("低点 ", "Trough ")}<time dateTime={rows[bottom].date}>{date(rows[bottom])}</time>
      </span> : undefined} />
  </div>;
}

function RiskDashboard({ data, scope, unavailable, retry, onBrush, rangeTrigger, inspection }: {
  onBrush?: (start:string,end:string)=>void;
  rangeTrigger: (button: HTMLElement | null) => void;
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
        className="max-phone:[&>.mx-panel-heading]:flex-col max-phone:[&>.mx-panel-heading]:items-start"
        title={t("历史收益回撤", "Historical return drawdown")}
        help={<>
          <p>{t("收益相对历史高点的回落幅度，使用全部可用历史。", "Return decline from the previous high across the full available history.")}</p>
          <DataBasis>{t(
            "组合按日终账户价值计算时间加权收益，以英镑计；不使用盘中记录。",
            "Time-weighted returns on end-of-day account values, in pounds; intraday records are not used.",
          )}</DataBasis>
        </>}
        action={<span className="mx-risk-basis flex flex-wrap items-baseline gap-x-2 text-[0.75rem] text-muted-foreground">
          {onBrush && dates.length > 1 && <Button type="button" variant="link" ref={rangeTrigger}
            className="mx-range-inspect-mobile min-h-(--mx-action-size) px-0 text-xs phone:hidden" onClick={() => onBrush(dates[0], dates.at(-1)!)}>
            {t("解读区间", "Read range")}
          </Button>}
          {t("全部可用历史", "All available history")} <PeriodSpan points={rows} />
        </span>}
      >
        <RiskReadings rows={rows} scope={scope} pending={!data && !unavailable} />
        {unavailable ? <div className="grid min-h-[260px] content-center"><InlineRetry {...unavailable} /></div>
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
  const label = accountName(profile, code);
  const unavailable = t("账户风险指标暂不可用", "Account risk metrics unavailable");
  return (
    <Panel
      title={label}
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
      <ReadStatus failure={!metrics && retry ? label + " · " + unavailable : undefined} ready={!!metrics}
        recovered={label + " · " + t("账户风险指标已恢复。", "Account risk metrics are available again.")} />
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
        <InlineRetry label={unavailable} retry={retry} />
      ) : <Empty title={t("风险数据暂不可用", "Risk metrics unavailable")} />}
    </Panel>
  );
}
