"use client";

import { Group, Select, Tooltip } from "@mantine/core";
import { drawdowns, minimumObserved } from "./performance-math";
import { useMemo, useState } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, NavPoint, RiskMetrics } from "@/lib/types";
import { HistoryChart, Legend, type ChartLine } from "./charts";
import { TimelineChart } from "./timeline-chart";
import type { TimelineLayer } from "./timeline-option";
import type { TimelineTooltip } from "./timeline-tooltip";
import {
  currency,
  difference,
  inRange,
  navNumber,
  observedNav,
  number,
  numeric,
  object,
  percent,
  periodReturn,
  tone,
  type Range,
  type Scope,
} from "./data";
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
  useCopy,
} from "./foundation";
import { Narrative } from "./narrative";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { HistoryCoverage, HistoryHelp } from "./history-coverage";
import { selectPortfolioHistory } from "./portfolio-history";

export function PerformanceWorkspace() {
  const t = useCopy();
  const query = useDashboardLens("analytics");
  return (
    <Page title={t("收益与风险", "Performance & risk")}>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        query.data && <PerformanceContent data={query.data} />
      )}
    </Page>
  );
}
export function PerformanceContent({
  data,
  fixedScope,
}: {
  data: DashboardLens;
  fixedScope?: Scope;
}) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const view =
    params.get("view") === "returns"
      ? "returns"
      : params.get("view") === "risk"
        ? "risk"
        : "money";
  const scope: Scope =
    fixedScope ??
    (["invest", "isa", "household", "cfd"].includes(params.get("scope") ?? "")
      ? (params.get("scope") as Scope)
      : "total");
  const [range, setRange] = useState<Range>("3M");
  const [benchmark, setBenchmark] = useState("ALL");
  const [moneyUnit, setMoneyUnit] = useState("gbp");
  const daily = useMemo(() => (data.nav ?? []).filter((p) => !p.intraday), [data.nav]);
  const actualRange = view !== "money" && range === "1D" ? "3M" : range;
  const history = useMemo(() => selectPortfolioHistory({
    daily, intraday: data.intradayNav, range: actualRange, scope,
    asOf: data.brokerAsOf,
  }), [daily, data.intradayNav, actualRange, scope, data.brokerAsOf]);
  const isIntraday = view === "money" && history.source === "intraday";
  const availablePoints = view === "money" ? history.points : inRange(daily, actualRange).filter((p) => navNumber(p, scope) != null);
  const allScope = [
    { value: "total", label: t("全部投资账户", "All investment accounts") },
    { value: "invest", label: accountName(profile, "A") },
    { value: "isa", label: accountName(profile, "B") },
  ];
  const scopeOptions =
    view === "money" && data.cfd
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
    view !== "money" && (scope === "cfd" || scope === "household");
  const requestedBenchmarks =
    benchmark === "ALL" ? ["VOO", "QQQ", "VT"] : [benchmark];
  const benchmarkMaps = requestedBenchmarks.map((name) => ({
    name,
    prices: new Map(
      (data.benchmarkSeries?.[name] ?? []).map((p) => [
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
  const change =
    points.length > 1
      ? difference(navNumber(first, scope), navNumber(last, scope))
      : null;
  const contributions =
    points.length > 1
      ? difference(
          navNumber(first, scope, "NetContributionsGbp"),
          navNumber(last, scope, "NetContributionsGbp"),
        )
      : null;
  const pnl =
    points.length > 1
      ? difference(
          navNumber(first, scope, "NetPnlGbp"),
          navNumber(last, scope, "NetPnlGbp"),
        )
      : null;
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
  const moneyDrawdown = drawdowns(
    points.map((p) => isIntraday ? navNumber(p, scope) : navNumber(p, scope, "NetPnlGbp")),
  );
  const valueChanges = points.map((p) => difference(navNumber(first, scope), navNumber(p, scope)));
  const valueChangePercents = valueChanges.map((value) => value != null && (navNumber(first, scope) ?? 0) > 0 ? value / navNumber(first, scope)! : null);
  const moneyDrawdownPercents = drawdowns(valueChangePercents, true);
  const periodPnls = points.map((p) => difference(navNumber(first, scope, "NetPnlGbp"), navNumber(p, scope, "NetPnlGbp")));
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
      : [
          {
            name: moneyUnit === "percent" ? t("价值变化", "Value change") : isIntraday ? t("账户估值", "Account valuation") : t("账户价值", "Account value"),
            values: points.map((p) =>
              moneyUnit === "gbp"
                ? navNumber(p, scope)
                : (navNumber(first, scope) ?? 0) > 0 &&
                    navNumber(p, scope) != null
                  ? navNumber(p, scope)! / navNumber(first, scope)! - 1
                  : null,
            ),
            area: true,
          },
          ...(isIntraday
            ? [{ name: t("期初价值", "Opening value"), colour: "accent" as const, dashed: true,
              values: points.map(() => moneyUnit === "gbp" ? navNumber(first, scope) : (navNumber(first, scope) ?? 0) > 0 ? 0 : null) }]
            : [
                {
                  name: moneyUnit === "percent" ? t("净入金变化", "Contribution change") : t("累计净入金", "Cumulative net contributions"),
                  values: points.map((p) =>
                    moneyUnit === "gbp"
                      ? navNumber(p, scope, "NetContributionsGbp")
                      : (navNumber(first, scope) ?? 0) > 0 &&
                          navNumber(p, scope, "NetContributionsGbp") != null &&
                          navNumber(first, scope, "NetContributionsGbp") != null
                        ? (navNumber(p, scope, "NetContributionsGbp")! -
                            navNumber(first, scope, "NetContributionsGbp")!) /
                          navNumber(first, scope)!
                        : null,
                  ),
                  colour: "accent" as const,
                  dashed: true,
                },
              ]),
        ];
  const timelineLayers: TimelineLayer[] = [
    {
      label:
        view === "money"
          ? moneyUnit === "percent" ? isIntraday ? t("相对期初价值变化", "Value change from opening") : t("价值与入金变化", "Value & contribution change") : isIntraday ? t("账户估值", "Account valuation") : t("价值与入金", "Value & contributions")
          : t("收益对比", "Return comparison"),
      lines: principalLines,
      percentage: view === "returns" || moneyUnit === "percent",
    },
    ...(view === "money" && !isIntraday
      ? [
          {
            label: t("区间净盈亏", "Period P&L"),
            lines: [
              {
                name: t("净盈亏", "Net P&L"),
                values: periodPnls,
                area: true,
              },
            ],
          },
        ]
      : []),
    {
      label: isIntraday ? t("价值回撤", "Value drawdown") : t("期间回撤", "Period drawdown"),
      percentage: view === "returns" || (isIntraday && moneyUnit === "percent"),
      drawdown: true,
      lines:
        view === "returns"
          ? returnDrawdowns
          : [
              {
                name: isIntraday ? t("价值回撤", "Value drawdown") : t("盈亏回撤", "P&L drawdown"),
                values: isIntraday && moneyUnit === "percent" ? moneyDrawdownPercents : moneyDrawdown,
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
          { label: isIntraday ? t("区间价值变化", "Value change") : t("区间净盈亏", "Period P&L"), values: isIntraday ? valueChanges : periodPnls, percentages: isIntraday ? valueChangePercents : undefined, signed: true },
          { label: isIntraday ? t("价值回撤", "Value drawdown") : t("盈亏回撤", "P&L drawdown"), values: moneyDrawdown, percentages: isIntraday ? moneyDrawdownPercents : undefined, signed: true },
        ],
    secondary: view === "returns"
      ? returnDrawdowns.map((line) => ({ label: `${line.name} · ${t("回撤", "drawdown")}`, values: line.values, percentage: true, signed: true }))
      : [
          { label: isIntraday ? t("账户估值", "Account valuation") : t("账户价值", "Account value"), values: points.map((p) => navNumber(p, scope)) },
          { label: t("期初价值", "Opening value"), values: points.map(() => navNumber(first, scope)) },
          ...(isIntraday
            ? []
            : [
                { label: t("累计净入金", "Cumulative net contributions"), values: points.map((p) => navNumber(p, scope, "NetContributionsGbp")) },
                { label: t("区间净入金", "Net contributions in period"), values: points.map((p) => difference(navNumber(first, scope, "NetContributionsGbp"), navNumber(p, scope, "NetContributionsGbp"))) },
              ]),
        ],
  };
  return (
    <>
      <div className="mx-toolbar">
        <Tabs
          label={t("绩效分析方式", "Performance perspective")}
          value={view}
          onChange={(v) =>
            update({
              view: v === "money" ? null : v,
              scope:
                v !== "money" && ["cfd", "household"].includes(scope)
                  ? null
                  : scope === "total"
                    ? null
                    : scope,
            })
          }
          options={[
            { value: "money", label: t("资金与盈亏", "Money & P&L") },
            { value: "returns", label: t("收益对比", "Return comparison") },
            { value: "risk", label: t("风险诊断", "Risk profile") },
          ]}
        />
        <Select
          disabled={!!fixedScope}
          aria-label={t("分析账户", "Analysis account")}
          value={scope}
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
        <RiskDashboard data={data} scope={scope} />
      ) : (
        <>
          <Panel
            title={
              view === "money"
                ? isIntraday ? t("账户估值与回撤", "Account valuation & drawdown") : t("账户价值与盈亏", "Account value & P&L")
                : t("收益对比", "Return comparison")
            }
            help={view === "money" && isIntraday ? <HistoryHelp /> : (
              <p>{view === "money" ? t(
                "净盈亏已扣除净入金，回撤从区间内盈亏高点计算。“相对期初 %”以期初账户价值为分母，不等于投资收益率。",
                "P&L excludes net contributions; drawdown is measured from its period high. From opening % uses opening account value as the base, not an investment return.",
              ) : t(
                "TWR 剔除出入金影响，与基准从共同起点比较。回撤从所选区间内的收益高点计算。",
                "TWR removes cash-flow effects and shares a starting date with benchmarks. Drawdown is measured from the return high within the selected period.",
              )}</p>
            )}
            action={
              <Segments
                value={actualRange}
              onChange={setRange}
                label={t("绩效区间", "Performance range")}
                options={(view === "money"
                  ? ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]
                  : ["1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]
                ).map((v) => ({
                  value: v as Range,
                  label: v === "ALL" ? t("全部", "All") : v === "1W" ? "5D" : v,
                }))}
              />
            }
          >
            <div className="mx-metric-grid" style={{ marginBottom: 27 }}>
              <Metric
                label={t("期末价值", "Ending value")}
                value={currency(navNumber(last, scope), "GBP", 2)}
              />
              <Metric
                label={
                  isIntraday
                    ? t("区间价值变化", "Value change")
                    : t("区间净入金", "Net contributions in period")
                }
                value={currency(
                  isIntraday ? change : contributions,
                  "GBP",
                  2,
                )}
                tone={isIntraday ? tone(change) : undefined}
              />
              <Metric
                label={
                  isIntraday
                    ? t("当前价值回撤", "Current value drawdown")
                    : t("区间净盈亏", "P&L in period")
                }
                value={
                  isIntraday ? currency(points.length > 1 ? moneyDrawdown.at(-1) : null, "GBP", 2) : currency(pnl, "GBP", 2)
                }
                tone={isIntraday ? "down" : tone(pnl)}
              />
              <Metric
                label={
                  view === "returns"
                    ? t("区间 TWR", "Time-weighted return")
                    : isIntraday ? t("最大价值回撤", "Maximum value drawdown") : t("期初价值", "Opening value")
                }
                value={
                  view === "returns"
                    ? percent(twr, true, 2)
                    : currency(isIntraday ? points.length > 1 ? minimumObserved(moneyDrawdown) : null : navNumber(first, scope), "GBP", 2)
                }
                tone={view === "returns" ? tone(twr) : isIntraday ? "down" : undefined}
              />
            </div>
            {view === "money" && (
              <Group justify="flex-end" mb="sm">
                <Segments
                  label={t("金额显示方式", "Value display")}
                  value={moneyUnit}
                  onChange={setMoneyUnit}
                  options={[
                    { value: "gbp", label: "GBP" },
                    {
                      value: "percent",
                      label: t("相对期初 %", "From opening %"),
                    },
                  ]}
                />
              </Group>
            )}
            {view === "money" && moneyUnit === "percent" && points.length > 0 && (navNumber(first, scope) ?? 0) <= 0 && (
              <Notice>{t("期初价值不大于零，无法显示百分比。请选择 GBP。", "Opening value is zero or negative. Select GBP to view amounts.")}</Notice>
            )}
            {view === "returns" && (
              <Group justify="flex-end" mb="sm">
                <Select
                  aria-label={t("比较基准", "Comparison benchmark")}
                  value={benchmark}
                  onChange={(v) => setBenchmark(v ?? "ALL")}
                  data={[
                    {
                      value: "ALL",
                      label: t(
                        "全部基准 · VOO / QQQ / VT",
                        "All benchmarks · VOO / QQQ / VT",
                      ),
                    },
                    { value: "VOO", label: "S&P 500 · VOO" },
                    { value: "QQQ", label: "Nasdaq 100 · QQQ" },
                    {
                      value: "VT",
                      label: t("全球股票 · VT", "Global equities · VT"),
                    },
                  ]}
                  w={260}
                />
              </Group>
            )}
            {view === "money" && <HistoryCoverage history={history} />}
              <TimelineChart
                dates={points.map((p) => p.date)}
                layers={timelineLayers}
                intraday={isIntraday}
                timeline={view === "money" ? history.timeline : undefined}
                observations={isIntraday ? points : undefined}
                tooltip={timelineTooltip}
                details={isIntraday ? [
                  { label: t("区间价值变化", "Value change"), values: valueChanges },
                  { label: t("相对期初", "From opening"), values: valueChangePercents, percentage: true },
                  ...(modelComparisons.some((value) => value != null) ? [{ label: t("同时段重建值", "Modeled value in this interval"), values: modelComparisons }] : []),
                ] : []}
                label={
                  view === "money"
                    ? isIntraday ? t("日内价值与回撤", "Intraday value and drawdown") : t(
                        "价值、盈亏与回撤的同日对照",
                        "Value, P&L and drawdown on a shared timeline",
                      )
                    : t(
                        "收益与回撤的同日对照",
                        "Returns and drawdowns on a shared timeline",
                      )
                }
              />
            <Legend items={(view === "returns" ? returnLines : principalLines).map((line) => ({ label: line.name }))} />
            {!isIntraday && (
              <>
                <div
                  className="mx-metric-grid"
                  style={{ marginTop: 24, marginBottom: 20 }}
                >
                  {(view === "returns"
                    ? returnDrawdowns
                    : [{ name: t("组合", "Portfolio"), values: moneyDrawdown }]
                  ).map((line) => (
                    <Metric
                      key={line.name}
                      label={
                        line.name + " · " + t("最大回撤", "Maximum drawdown")
                      }
                      value={
                        view === "returns"
                          ? percent(minimumObserved(line.values), false, 2)
                          : currency(minimumObserved(line.values), "GBP", 2)
                      }
                      tone="down"
                    />
                  ))}
                  <Metric
                    label={t("期末回撤", "Ending drawdown")}
                    value={
                      view === "returns"
                        ? percent(returnDrawdowns[0]?.values.at(-1), false, 2)
                        : currency(moneyDrawdown.at(-1), "GBP", 2)
                    }
                    tone="down"
                  />
                </div>
              </>
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
                {data.cfd?.accountStatus === "retired" &&
                  t("该账户已停用。", "This account is retired.")}
              </Notice>
            )}
          </Panel>
          {view === "returns" && (
            <MonthlyReturns points={daily} scope={scope} />
          )}
        </>
      )}
      <Narrative
        snapshot={data.runId}
        lens="return_attribution"
        page="analytics"
      />
    </>
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
      <Freshness date={data.brokerAsOf} />
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
        "Sharpe 同时考虑上下波动；Sortino 侧重下行风险。缺失指标表示数据不足，不等于零风险。",
        "Sharpe accounts for all volatility; Sortino focuses on downside risk. Missing metrics indicate insufficient data, not zero risk.",
      )}
      description={t(
        "指标基于完整可用历史",
        "Metrics use the full available history",
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
                t("信息比率", "Information ratio"),
                number(metrics.informationRatio),
              ],
              [t("比较基准", "Benchmark"), metrics.benchmark],
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
        <div
          className="mx-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("数据表格", "Data table")}
        >
          <table className="mx-table">
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
                      <td key={key} style={{ padding: "17px 9px" }}>
                        <Tooltip label={key}>
                          <span
                            className={value == null ? "" : "mx-" + tone(value)}
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
