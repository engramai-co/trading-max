"use client";

import { Select, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { CaretRight } from "@phosphor-icons/react";
import { drawdowns, minimumObserved } from "@/lib/portfolio/math";
import { useMemo, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import type { DashboardLens, NavPoint, RiskMetrics } from "@/lib/types";
import { HistoryChart, Legend, type ChartLine } from "./charts";
import { TimelineChart } from "./timeline-chart";
import type { TimelineLayer } from "./timeline-option";
import type { TimelineTooltip } from "./timeline-tooltip";
import { number, percent, tone } from "@/workspace/data";
import { inRange, navNumber, observedNav, periodReturn, type Scope } from "@/lib/portfolio/nav";
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
  const { params, update } = useRouteState();
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
  const [benchmark, setBenchmark] = useState("VOO");
  const [moneyUnit, setMoneyUnit] = useState("gbp");
  const requestedRange = view === "risk" ? "ALL" : view === "returns" && range === "1D" ? "3M" : range;
  const selection = useMemo(() => ({ range: requestedRange, scope: requestedScope, detail: "summary" as const }),
    [requestedRange, requestedScope]);
  // The account review lens supplies account history but no benchmark prices.
  const usesAnalytics = !suppliedData || view === "returns";
  const summary = useDashboardLens("analytics", undefined, usesAnalytics, selection);
  const incoming = usesAnalytics ? summary.data : suppliedData;
  const historyQuery = usePortfolioHistory({ runId: incoming?.runId ?? "", range: requestedRange, scope: requestedScope },
    view === "money" && Boolean(incoming?.runId));
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
  const shown = retained?.view === view && retained.scope === requestedScope ? retained : undefined;
  const data = shown?.data;
  const scope = shown?.scope ?? requestedScope;
  const actualRange = shown?.range ?? requestedRange;
  const historySelection = { runId: data?.runId ?? "", range: actualRange, scope };
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
  const availablePoints = view === "money" ? history.points : inRange(daily, actualRange).filter((p) => navNumber(p, scope) != null);
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
      colour: "text",
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
      colour: (["axis", "accent", "secondary"] as const)[i],
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
  const timelineLayers: TimelineLayer[] = [
    ...(view === "money" ? [
      {
        label: t("区间净盈亏", "Period P&L"),
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
          ? t("价值与入金变化", "Value & contribution change")
          : t("账户价值与累计净入金", "Account value & cumulative net contributions"),
        percentage: moneyUnit === "percent",
        lines: portfolioValueLines(points, scope, t, moneyUnit === "percent"),
      },
    ] : [{ label: t("收益对比", "Return comparison"), lines: returnLines, percentage: true }]),
    {
      label: view === "money" ? t("盈亏回撤", "P&L drawdown") : t("期间回撤", "Period drawdown"),
      percentage: view === "returns" || moneyUnit === "percent",
      drawdown: true,
      markerDate: view === "money" ? money.drawdownEpisode?.trough.date : undefined,
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
  const timelineTooltip: TimelineTooltip = {
    account: scopeOptions.find((option) => option.value === scope)?.label,
    range: rangeName(actualRange, t("全部", "All")),
    unit: view === "returns" ? "%" : "GBP",
    primary: view === "returns"
      ? returnLines.map((line) => ({ label: line.name, values: line.values, percentage: true, signed: true }))
      : [
          { label: t("区间净盈亏", "Period P&L"), values: periodPnls, percentages: money.pnlPercents, signed: true },
          { label: t("盈亏回撤", "P&L drawdown"), values: moneyDrawdown, percentages: moneyDrawdownPercents, signed: true },
        ],
    secondary: view === "returns"
      ? returnDrawdowns.map((line) => ({ label: `${line.name} · ${t("回撤", "drawdown")}`, values: line.values, percentage: true, signed: true }))
      : [
          { label: t("账户价值", "Account value"), values: points.map((p) => navNumber(p, scope)) },
          { label: t("期初价值", "Opening value"), values: points.map(() => navNumber(first, scope)) },
          { label: t("累计净入金", "Cumulative net contributions"), values: points.map((p) => navNumber(p, scope, "NetContributionsGbp")) },
          { label: t("区间净入金", "Net contributions in period"), values: money.periodFlows },
        ],
  };
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
            "Select Invest, ISA, or all investment accounts to analyze returns and risk.",
          )}
        </Notice>
      ) : view === "risk" ? (
        <div className="mx-data-body mx-performance-risk" aria-busy={waiting || undefined}>
          <RiskDashboard data={runtime.status === "ready" ? data : undefined} scope={scope}
            unavailable={unavailable} retry={usesAnalytics ? summary.refetch : undefined} />
        </div>
      ) : (
        <>
          <Panel>
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
                  aria-label={t("比较基准", "Comparison benchmark")}
                  value={benchmark}
                  onChange={(v) => setBenchmark(v ?? "VOO")}
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
                <DashboardRanges value={requestedRange} onChange={(value) => update({ range: value })}
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
                  help={t(
                    "TWR 剔除出入金影响，与基准从共同起点比较。回撤从所选区间内的收益高点计算。",
                    "TWR removes cash-flow effects and shares a starting date with benchmarks. Drawdown is measured from the return high within the selected period.",
                  )}
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
              {view === "returns" && <Legend items={returnLines.map((line, i) => ({
                label: line.name, dashed: line.dashed,
                colour: ["var(--mx-ink)", "var(--mx-muted)", "var(--mx-chart-1)", "var(--mx-chart-2)"][i],
              }))} />}
              <TimelineChart
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
                tooltip={timelineTooltip}
                details={isIntraday ? [
                  { label: t("区间价值变化", "Value change"), values: valueChanges },
                  { label: t("相对期初", "From opening"), values: valueChangePercents, percentage: true },
                  ...(modelComparisons.some((value) => value != null) ? [{ label: t("同时段重建值", "Modeled value in this interval"), values: modelComparisons }] : []),
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
            {view === "returns" && (
              <div className="mx-table-wrap mx-return-table" tabIndex={0} role="region" aria-label={t("收益与回撤对比", "Return and drawdown comparison")}>
                <table className="mx-table">
                  <thead>
                    <tr>
                      <th><span className="sr-only">{t("曲线", "Series")}</span></th>
                      <th className="mx-align-right">{t("区间收益", "Period return")}</th>
                      <th className="mx-align-right">{t("最大回撤", "Maximum drawdown")}</th>
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
                  "CFD 使用导入的已实现现金权益代理，不代表当前券商净值。",
                  "CFD values use an imported realized cash equity proxy, not current broker NAV.",
                )}{" "}
                {data?.cfd?.accountStatus === "retired" &&
                  t("该账户已停用。", "This account is retired.")}
              </Notice>
            )}
            </div>}
          </Panel>
          {view === "returns" && shown && runtime.status === "ready" && (
            <div className="mx-data-body" aria-busy={waiting || undefined}><MonthlyReturns points={daily} scope={scope} /></div>
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
    <Metric label={t("最大回撤", "Maximum drawdown")}
      value={pending ? placeholder : percent(maximum, false, 2)} tone={tone(maximum)}
      note={peak ? <span className="mx-risk-drawdown-episode">
        {t("高点 ", "Peak ")}<time dateTime={peak.date}>{date(peak)}</time>
        <span aria-hidden="true"> → </span>
        {t("低点 ", "Trough ")}<time dateTime={rows[bottom].date}>{date(rows[bottom])}</time>
      </span> : undefined} />
  </div>;
}

function RiskDashboard({ data, scope, unavailable, retry }: {
  data?: DashboardLens;
  scope: Scope;
  unavailable: { label: string; retry: () => unknown } | null;
  retry?: () => unknown;
}) {
  const t = useCopy();
  const rows = observedNav(data?.nav ?? [], scope, "Drawdown");
  return (
    <>
      <Panel
        title={t("历史收益回撤", "Historical return drawdown")}
        help={t("收益相对历史高点的回落幅度，使用全部可用历史。", "Return decline from the previous high across the full available history.")}
        action={<span className="mx-risk-basis">{t("全部可用历史", "All available history")} <PeriodSpan points={rows} /></span>}
      >
        <RiskReadings rows={rows} scope={scope} pending={!data && !unavailable} />
        {unavailable ? <div className="mx-performance-unavailable"><InlineRetry {...unavailable} /></div>
          : !data ? <Pending shape="chart" height={260} quiet />
          : <HistoryChart
          label={t("收益回撤曲线", "Portfolio return drawdown")}
          dates={rows.map((p) => p.date)}
          lines={[
            {
              name: t("回撤", "Drawdown"),
              values: rows.map((p) => navNumber(p, scope, "Drawdown")),
              colour: "negative",
              area: true,
            },
          ]}
          percentage
          height={260}
        />}
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
        <TextLink href={"/account-analysis?account=" + code}>
          {t("账户复盘", "Review account")}
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
              label={t("最大回撤", "Maximum drawdown")}
              value={percent(metrics.maxDrawdown)}
              tone="down"
            />
            <Metric
              label={t("年化波动", "Annualized volatility")}
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
                t("年化收益", "Annualized return"),
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
function MonthlyReturns({ points, scope }: { points: NavPoint[]; scope: Scope }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return <Panel>
    <details className="mx-monthly-returns" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><CaretRight size={14} aria-hidden="true" />{t("月度收益（TWR）", "Monthly returns (TWR)")}</summary>
      {open && <>
        <p>{t("剔除出入金影响的月度收益。首月从最早记录起算，最近一月截至最新记录。", "Monthly returns excluding cash-flow effects. The first month starts at the first observation; the latest month ends at the last available observation.")}</p>
        <MonthlyReturnTable points={points} scope={scope} />
      </>}
    </details>
  </Panel>;
}

function MonthlyReturnTable({ points, scope }: { points: NavPoint[]; scope: Scope }) {
  const t = useCopy();
  const { locale } = useLocale();
  const map = new Map<string, number | null>();
  const sorted = inRange(points, "ALL").filter(
    (p) => navNumber(p, scope, "Twr") != null,
  );
  const months = [...new Set(sorted.map((p) => p.date.slice(0, 7)))];
  for (const month of months) {
    const rows = sorted.filter((p) => p.date.startsWith(month));
    const prior =
      sorted.filter((p) => p.date.slice(0, 7) < month).at(-1) ?? rows[0];
    map.set(
      month,
      rows.at(-1) === prior
        ? null
        : periodReturn(
            navNumber(prior, scope, "Twr"),
            navNumber(rows.at(-1), scope, "Twr"),
          ),
    );
  }
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].reverse();
  return years.length ? (
    <>
      <div
        className="mx-table-wrap mx-month-table-wrap"
        tabIndex={0}
        role="region"
        aria-label={t("数据表格", "Data table")}
      >
        <table className="mx-table mx-month-table">
          <thead>
            <tr>
              <th>{t("年份", "Year")}</th>
              {Array.from({ length: 12 }, (_, i) => (
                <th key={i}>{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((year) => (
              <tr key={year}>
                <th>{year}</th>
                {Array.from({ length: 12 }, (_, i) => {
                  const key = year + "-" + String(i + 1).padStart(2, "0");
                  const value = map.get(key);
                  return (
                    <td
                      key={key}
                      className="mx-month-return"
                    >
                      <Tooltip label={formatDate(key + "-01T00:00:00Z", locale, { year: "numeric", month: "long", timeZone: "UTC" })}>
                        <span
                          className={value == null ? "mx-heat-empty" : "mx-heat-pill mx-" + tone(value)}
                          // Fill strength follows the size of the move, capped at 10%.
                          style={value == null ? undefined : { ["--mx-heat" as string]: Math.min(1, Math.abs(value) / 0.1).toFixed(2) }}
                        >
                          {percent(value, true)}
                        </span>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phones read a year as four rows of three months instead of scrolling sideways. */}
      <div className="mx-month-cards">
        {years.map((year) => (
          <section key={year} aria-label={year}>
            <h3>{year}</h3>
            <div>
              {Array.from({ length: 12 }, (_, i) => {
                const key = year + "-" + String(i + 1).padStart(2, "0");
                const value = map.get(key);
                return (
                  <span key={key}>
                    <small>{formatDate(key + "-01T00:00:00Z", locale, { month: "short", timeZone: "UTC" })}</small>
                    <span
                      className={value == null ? "mx-heat-empty" : "mx-heat-pill mx-" + tone(value)}
                      style={value == null ? undefined : { ["--mx-heat" as string]: Math.min(1, Math.abs(value) / 0.1).toFixed(2) }}
                    >
                      {percent(value, true)}
                    </span>
                  </span>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  ) : (
    <Empty title={t("需要更多每日收益记录", "More daily return observations are needed")} />
  );
}
