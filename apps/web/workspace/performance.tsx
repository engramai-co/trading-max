"use client";

import { Select, Tooltip } from "@mantine/core";
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
import { number, object, percent, tone } from "@/workspace/data";
import { inRange, navNumber, observedNav, periodReturn, type Range, type Scope } from "@/lib/portfolio/nav";
import { numeric } from "@/lib/numeric";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
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
import { PORTFOLIO_RANGES, portfolioRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { portfolioValueLines } from "./portfolio-value-lines";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { MoneyDrawdown, MoneySummary } from "./performance-money";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useRetainedResult } from "./retained-result";

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
  const [benchmark, setBenchmark] = useState("ALL");
  const [moneyUnit, setMoneyUnit] = useState("gbp");
  const requestedRange = view !== "money" && range === "1D" ? "3M" : range;
  const selection = useMemo(() => ({ range: requestedRange, scope: requestedScope, detail: "summary" as const }),
    [requestedRange, requestedScope]);
  const summary = useDashboardLens("analytics", undefined, !suppliedData, selection);
  const incoming = suppliedData ?? summary.data;
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
  const shown = retained?.view === view ? retained : undefined;
  const data = shown?.data;
  const scope = shown?.scope ?? requestedScope;
  const actualRange = shown?.range ?? requestedRange;
  const historySelection = { runId: data?.runId ?? "", range: actualRange, scope };
  const daily = useMemo(() => (data?.nav ?? []).filter((p) => !p.intraday), [data?.nav]);
  const failure = summary.isError ? summary : view === "money" && historyQuery.isError ? historyQuery : null;
  const publicationFailure = usePublicationFailure(suppliedData ? 0 : shown?.updatedAt ?? 0);
  const inlineFailure = failure && shown ? { updatedAt: shown.updatedAt, retry: failure.refetch } : publicationFailure;
  const waiting = !failure && !current || runtime.status === "loading";
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
    view === "money" && data?.cfd
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
  const requestedBenchmarks =
    benchmark === "ALL" ? ["VOO", "QQQ", "VT"] : [benchmark];
  const benchmarkMaps = requestedBenchmarks.map((name) => ({
    name,
    prices: new Map(
      (data?.benchmarkSeries?.[name] ?? []).map((p) => [
        p.date.slice(0, 10),
        numeric(object(p).close ?? object(p).price),
      ]),
    ),
  }));
  const usableBenchmarks = benchmarkMaps.filter(
    (b) =>
      availablePoints.filter(
        (p) => (b.prices.get(p.date.slice(0, 10)) ?? 0) > 0,
      ).length > 1,
  );
  const common = availablePoints.filter(
    (p) =>
      navNumber(p, scope, "Twr") != null &&
      usableBenchmarks.every(
        (b) => (b.prices.get(p.date.slice(0, 10)) ?? 0) > 0,
      ),
  );
  const returnsPoints =
    common.length > 1
      ? common
      : availablePoints.filter((p) => navNumber(p, scope, "Twr") != null);
  const points = view === "returns" ? returnsPoints : availablePoints;
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
      values: returnsPoints.map((p) =>
        periodReturn(
          navNumber(returnsPoints[0], scope, "Twr"),
          navNumber(p, scope, "Twr"),
        ),
      ),
      area: true,
    },
    ...(common.length > 1
      ? usableBenchmarks.map(
          (b, i): ChartLine => ({
            name: b.name,
            colour: (["accent", "secondary", "negative"] as const)[i],
            dashed: true,
            values: returnsPoints.map((p) => {
              const start = b.prices.get(returnsPoints[0]?.date.slice(0, 10));
              const end = b.prices.get(p.date.slice(0, 10));
              return start != null && start > 0 && end != null
                ? end / start - 1
                : null;
            }),
          }),
        )
      : []),
  ];
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
  const principalLines: ChartLine[] =
    view === "returns"
      ? returnLines
      : portfolioValueLines(points, scope, t, moneyUnit === "percent");
  const timelineLayers: TimelineLayer[] = [
    {
      label:
        view === "money"
          ? moneyUnit === "percent" ? t("价值与入金变化", "Value & contribution change") : t("价值与入金", "Value & contributions")
          : t("收益对比", "Return comparison"),
      lines: principalLines,
      percentage: view === "returns" || moneyUnit === "percent",
    },
    ...(view === "money"
      ? [
          {
            label: t("区间净盈亏", "Period P&L"),
            percentage: moneyUnit === "percent",
            zeroBaseline: true,
            markerDate: money.drawdownEpisode?.peak.date,
            lines: [
              {
                name: t("净盈亏", "Net P&L"),
                values: moneyUnit === "percent" ? money.pnlPercents : periodPnls,
                area: true,
              },
            ],
          },
        ]
      : []),
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
    range: actualRange === "1W" ? "5D" : actualRange === "ALL" ? t("全部", "All") : actualRange,
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
          <Freshness date={data?.brokerAsOf} />
          {inlineFailure && <UpdateFailure {...inlineFailure} />}
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
        runtime.status === "failed" ? <QueryError retry={runtime.retry} />
          : data && runtime.status === "ready" ? <div className="mx-data-body mx-performance-risk" aria-busy={waiting || undefined}>
            <RiskDashboard data={data} scope={scope} />
          </div>
          : failure ? <QueryError retry={failure.refetch} />
          : <Pending shape="analytics" label={t("正在读取风险记录…", "Loading risk records…")} />
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
                  onChange={(v) => setBenchmark(v ?? "ALL")}
                  data={[
                    {
                      value: "ALL",
                      label: t(
                        "VOO · QQQ · VT",
                        "VOO · QQQ · VT",
                      ),
                    },
                    { value: "VOO", label: "S&P 500 · VOO" },
                    { value: "QQQ", label: "Nasdaq 100 · QQQ" },
                    {
                      value: "VT",
                      label: t("全球股票 · VT", "Global equities · VT"),
                    },
                  ]}
                  w={220}
                />
              )}
              <div className="mx-period-control">
                <PeriodSpan points={points} reserve />
                <Segments
                  value={requestedRange}
                  onChange={(value) => update({ range: value })}
                  label={t("绩效区间", "Performance range")}
                  shortcuts
                  options={PORTFOLIO_RANGES.filter((v) => view === "money" || v !== "1D").map((v) => ({
                    value: v as Range,
                    label: v === "ALL" ? t("全部", "All") : v === "1W" ? "5D" : v,
                  }))}
                />
              </div>
            </div>
            {runtime.status === "failed" ? <QueryError retry={runtime.retry} />
              : failure && !shown ? <QueryError retry={failure.refetch} />
              : !shown || runtime.status === "loading" ? (
                <Pending shape="analytics" height={view === "money" ? 797 : 601}
                  label={t("正在读取收益记录…", "Loading performance records…")} />
              ) : <div className="mx-data-body" aria-busy={waiting || undefined}>
            {view === "money" && <HistoryCoverage history={history} />}
            {view === "money" ? (
              <MoneySummary money={money} points={points} />
            ) : (
              <div className="mx-metric-grid mx-metric-lead mx-chart-metrics">
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
              </div>
            )}
            {view === "money" && moneyUnit === "percent" && points.length > 0 && (navNumber(first, scope) ?? 0) <= 0 && (
              <Notice>{t("期初价值不大于零，无法显示百分比。请选择 GBP。", "Opening value is zero or negative. Select GBP to view amounts.")}</Notice>
            )}
              {/* Series names sit above the chart they explain. */}
              <Legend items={(view === "returns" ? returnLines : principalLines).map((line) => ({ label: line.name }))} />
              <TimelineChart
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
                        "价值、盈亏与回撤的同日对照",
                        "Value, P&L and drawdown on a shared timeline",
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
            {view === "returns" &&
              (common.length < 2 ||
                usableBenchmarks.length < requestedBenchmarks.length) && (
                <Notice>
                  {t(
                    "部分基准缺少足够的共同日期，未绘制的基准不参与比较。所有已绘制曲线使用相同起点。",
                    "Some benchmarks lack shared observations and are omitted. All displayed lines use the same starting date.",
                  )}
                </Notice>
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
function RiskDashboard({ data, scope }: { data: DashboardLens; scope: Scope }) {
  const t = useCopy();
  const rows = observedNav(data.nav ?? [], scope, "Drawdown");
  return (
    <>
      <Panel
        title={t("历史收益回撤", "Historical return drawdown")}
        help={t("收益相对历史高点的回落幅度，使用全部可用历史。", "Return decline from the previous high across the full available history.")}
      >
        <HistoryChart
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
        />
      </Panel>
      <div className="mx-grid">
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
            />
          ))}
      </div>
    </>
  );
}
function RiskCard({
  metrics,
  code,
}: {
  metrics?: RiskMetrics;
  code: "A" | "B";
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
      ) : (
        <Empty title={t("风险数据暂不可用", "Risk metrics unavailable")} />
      )}
    </Panel>
  );
}
function MonthlyReturns({
  points,
  scope,
}: {
  points: NavPoint[];
  scope: Scope;
}) {
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
  return (
    <Panel
      title={t("月度收益（TWR）", "Monthly returns (TWR)")}
      help={t("剔除出入金影响的月度收益。首月从最早记录起算，最近一月截至最新记录。", "Monthly returns excluding cash-flow effects. The first month starts at the first observation; the latest month ends at the last available observation.")}
    >
      {years.length ? (
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
        <Empty
          title={t(
            "需要更多每日收益记录",
            "More daily return observations are needed",
          )}
        />
      )}
    </Panel>
  );
}
