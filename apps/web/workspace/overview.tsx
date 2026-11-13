"use client";

/*
 * Direction contract — 首页「账本在下」(owner-pinned 合并账本 with a pie; seed 34de5601), comp-led.
 * THESIS: the morning read in three bands: what the money did, how far the chosen market's sectors went today, and every
 *   holding with its research on one row. No separate allocation, account or research boxes.
 * OWN-WORLD: the Quiet Ledger, unchanged: white hairline panels on the cool canvas, ink figures, cobalt only
 *   for links and selection, green and red only for gains and losses, sector heat washes.
 * STORY: read the value → the period curve, today's movers under the 1D figure → which sectors moved → each holding's weight, day,
 *   P&L, score and model upside, flags marked in place → open research or a sector.
 * FIRST VIEWPORT: the summary across the top; 区间净盈亏 (about 62%) beside the sector map, US by default (about 38%);
 *   the 持仓 panel below: donut left, ledger right.
 * FORM: 账本在下, the owner's pick among three pie variants of the dealt 合并账本 (index 1, seed 34de5601);
 *   approved comp .impeccable/mocks/decision/overview-r2-ledgerpie.png.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict,
 *   DESIGN.md, and every shipping raster carrying its provenance.
 */

import { Button, Select } from "@mantine/core";
import { ChartLine } from "@phosphor-icons/react";
import Link from "./link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, RefreshAttention } from "@/lib/types";
import { TimelineChart } from "./timeline-chart";
import { api, currency, percent, tone } from "@/workspace/data";
import { useLocale } from "@/components/locale-provider";
import { attentionItems, type AttentionItem } from "./attention";
import { type Range, type Scope } from "@/lib/portfolio/nav";
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
  TextLink,
  UpdateFailure,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { Narrative } from "./narrative";
import { HistoryCoverage, HistoryHelp, PeriodSpan } from "./history-coverage";
import { DayDrivers, dayDrivers, driverOpenings } from "./day-drivers";
import { portfolioPerformanceHref, portfolioRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { ReadingBoundary, useReadingBoundary } from "@/ui/charts/reading";
import { usePublicationFailure } from "@/ui/publication-provider";
import { useCurrentDay } from "./current-day";
import { DemoAsOf, useDemonstration } from "./demonstration";
import { LocalOnboarding } from "./local-onboarding";
import { OverviewHoldings } from "./overview-holdings";
import { OverviewSectors } from "./overview-sectors";
import { useChartRuntime } from "@/ui/charts/use-echarts";
import { useRetainedResult } from "./retained-result";
import { DashboardRanges, InlineRetry, WaitingAsOf, rangeName } from "./dashboard-controls";

export function OverviewWorkspace({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  return (
    <Page className="mx-overview-page" title={t("组合总览", "Portfolio overview")} titleHidden>
      <OverviewContent localWorkspace={localWorkspace} />
    </Page>
  );
}
function OverviewContent({ localWorkspace }: { localWorkspace: boolean }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const { now } = useCurrentDay();
  const query = useDashboardLens("overview", undefined, true, { detail: "summary" });
  const incoming = query.data;
  const reading = useReadingBoundary();
  const runtime = useChartRuntime();
  const demonstration = useDemonstration();
  const refresh = useQuery({
    queryKey: ["refresh-attention"],
    queryFn: ({ signal }) => api<RefreshAttention>("/refresh/attention", { signal }),
    enabled: !demonstration,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const requestedScope: Scope =
    params.get("scope") === "invest"
      ? "invest"
      : params.get("scope") === "isa"
        ? "isa"
        : "total";
  const range = portfolioRange(params.get("range"), "1D");
  const selection = useMemo(() => ({ range, scope: requestedScope, runId: incoming?.runId ?? "" }), [range, requestedScope, incoming?.runId]);
  const openings = useMemo(() => driverOpenings(range === "1D" ? incoming?.dayAttribution : range === "1W" ? incoming?.windowAttribution : null, requestedScope),
    [range, requestedScope, incoming?.dayAttribution, incoming?.windowAttribution]);
  const history = usePortfolioHistory(selection, Boolean(incoming?.runId), openings);
  // Only publish matching figures, attributions and history together. An open chart reading
  // stays on its own run. An explicit range or account choice still proceeds.
  const candidate = useMemo(() => incoming && {
    lens: incoming, selection, history: history.data,
    updatedAt: Math.max(query.dataUpdatedAt, history.dataUpdatedAt),
  }, [incoming, selection, history.data, query.dataUpdatedAt, history.dataUpdatedAt]);
  const complete = candidate?.history && runtime.status !== "loading" ? candidate : undefined;
  const retained = useRetainedResult(complete, Object.is, (next, previous) =>
    !reading.active || next.selection.range !== previous.selection.range || next.selection.scope !== previous.selection.scope);
  const shown = retained?.selection.scope === requestedScope ? retained : undefined;
  const initialWaiting = !shown && !query.isError && (
    !incoming || history.isPending || runtime.status === "loading");
  const displayed = shown ?? candidate;
  const data = displayed?.lens;
  const scope = displayed?.selection.scope ?? requestedScope;
  const publicationFailure = usePublicationFailure(shown?.updatedAt ?? 0);
  const summaryFailure = query.isRefetchError
    ? { updatedAt: shown?.updatedAt ?? query.dataUpdatedAt, retry: query.refetch }
    : publicationFailure;
  const historyFailure = history.isError && shown
    ? { updatedAt: shown.updatedAt, retry: history.refetch } : undefined;
  const accounts = (data?.accounts ?? []).filter((a) => a.isInvestable);
  const selected = accounts.find(
    (a) => a.code === (scope === "invest" ? "A" : scope === "isa" ? "B" : ""),
  );
  const holdings = (data?.holdings ?? []).filter(
    (h) => scope === "total" || h.account === (scope === "invest" ? "A" : "B"),
  );
  if (!data && query.isError && localWorkspace) return <LocalOnboarding showAccountLink />;
  if (data && !accounts.length && data.totalValueGbp == null)
    return (
      <Panel>
        <Empty
          title={t("暂无账户数据", "No account data")}
          description={t(
            "连接 Trading\u00a0212 账户，完成首次同步后即可查看资产和投资表现。",
            "Connect a Trading\u00a0212 account and sync once to see your investments here.",
          )}
          action={
            <Button component={Link} href="/settings">
              {t("连接账户", "Connect an account")}
            </Button>
          }
        />
      </Panel>
    );
  const pnl =
    scope === "total" ? data?.totalUnrealizedPnlGbp : selected?.unrealizedPnlGbp;
  const cash = scope === "total" ? data?.totalCashGbp : selected?.cashGbp;
  const value =
    scope === "total" ? data?.totalValueGbp : selected?.totalValueGbp;
  const previousDay =
    scope === "total" ? data?.latestModelDayReturn : selected?.dailyReturn;
  // Data problems speak here; a holding's readings are marked in its own row below.
  const attention = demonstration ? [] : attentionItems({ brokerAsOf: data?.brokerAsOf, refresh: refresh.data, now });
  return (
    <ReadingBoundary.Provider value={reading.report}><div className="mx-overview-read">
      <div className="mx-panel mx-overview-portfolio">
        <section
          className="mx-summary"
          aria-label={t("组合资产", "Portfolio assets")}
        >
          <div className="mx-summary-top">
            <Select
              aria-label={t("组合账户", "Portfolio account")}
              w={186}
              data={[
                {
                  value: "total",
                  label: t("全部投资账户", "All investment accounts"),
                },
                { value: "invest", label: accountName(profile, "A") },
                { value: "isa", label: accountName(profile, "B") },
              ]}
              value={requestedScope}
              onChange={(v) => update({ scope: v === "total" ? null : v })}
            />
            <span className="mx-freshness-group">
              {initialWaiting ? <WaitingAsOf label={t("正在读取资产记录…", "Loading portfolio assets…")} />
                : demonstration ? <DemoAsOf date={data?.brokerAsOf} /> : <Freshness date={data?.brokerAsOf} />}
              {summaryFailure && <UpdateFailure {...summaryFailure} />}
            </span>
          </div>
          {initialWaiting ? <Pending shape="summary" quiet /> : !data && query.isError ? (
            <div className="mx-overview-summary-failure">
              <InlineRetry label={t("资产记录暂不可用", "Portfolio assets unavailable")} retry={query.refetch} />
              <TextLink href="/health">{t("查看数据状态", "Data status")}</TextLink>
            </div>
          ) : <>
          <div className="mx-overview-totals">
            <Metric
              large
              label={t("总资产", "Portfolio value")}
              value={currency(value, "GBP", 2)}
            />
            <div className="mx-overview-statistics">
              <Metric
                label={t("浮动盈亏", "Unrealized P&L")}
                value={currency(pnl, "GBP", 2)}
                tone={tone(pnl)}
                help={t("当前持仓相对买入成本", "Open positions versus cost")}
              />
              <Metric
                label={t("现金", "Cash balance")}
                value={currency(cash, "GBP", 2)}
              />
            </div>
          </div>
          <Attention items={attention} />
          </>}
        </section>
        {!initialWaiting && scope !== "total" && !selected && (
          <div className="mx-overview-notice">
            <Notice>
              {t(
                "这份快照还没有该账户的数据。请检查账户连接并完成更新。",
                "This snapshot has no data for this account. Check its connection and run an update.",
              )}
            </Notice>
          </div>
        )}
      </div>
      <div className="mx-overview-row">
        <OverviewHistory
          range={range}
          selection={displayed?.selection ?? selection}
          data={displayed?.history}
          failed={history.isError || !data && query.isError}
          retry={!data && query.isError ? query.refetch : history.refetch}
          failure={historyFailure}
          waiting={Boolean(shown && shown !== complete && !reading.active)}
          initialWaiting={initialWaiting}
          runtime={runtime}
          onRange={(value) => update({ range: value })}
          dayAttribution={data?.dayAttribution}
          windowAttribution={data?.windowAttribution}
          previousDay={previousDay}
        />
        <OverviewSectors />
      </div>
      {initialWaiting ? <Panel className="mx-overview-holdings" title={t("持仓", "Holdings")}><Pending shape="holdings" quiet /></Panel>
        : <OverviewHoldings holdings={holdings} technical={data?.technical} valuations={data?.valuations}
          runId={data?.runId === incoming?.runId && scope === requestedScope ? data?.runId : undefined}
          brokerAsOf={data?.brokerAsOf} account={requestedScope} />}
      {!initialWaiting && data && <Narrative snapshot={data.runId} lens="daily_cio_brief" page="overview" />}
    </div></ReadingBoundary.Provider>
  );
}
function Attention({ items }: { items: AttentionItem[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  const zh = locale === "zh";
  if (!items.length) return null;
  const age = (hours: number) => {
    const days = Math.floor(hours / 24);
    if (days >= 2) return zh ? `账户数据 ${days} 天未更新` : `No account update for ${days} days`;
    return zh ? `账户数据 ${hours} 小时未更新` : `No account update for ${hours} hours`;
  };
  return (
    <nav className="mx-attention" aria-label={t("需要关注", "Needs attention")}>
      {items.map((item) =>
        item.kind === "refresh" ? (
          <Link key="refresh" href="/health" data-tone="warning">
            <strong>{item.scope === "accounts"
              ? t("账户更新连续失败", "Account updates failing")
              : t("收益更新连续失败", "Performance updates failing")}</strong>
            <span>{item.minutes >= 60
              ? Math.floor(item.minutes / 60) + t(" 小时", "h")
              : item.minutes > 0 ? item.minutes + t(" 分钟", "m")
                : item.failures + t(" 次", " attempts")}</span>
          </Link>
        ) : (
          <Link key="stale" href="/health" data-tone="warning">
            {age(item.hours)}
          </Link>
        ),
      )}
    </nav>
  );
}
function OverviewHistory({
  range: requestedRange, selection, data, failed, retry, failure, waiting, initialWaiting, runtime, onRange,
  dayAttribution, windowAttribution, previousDay,
}: {
  range: Range;
  selection: Parameters<typeof usePortfolioHistory>[0];
  data?: ReturnType<typeof usePortfolioHistory>["data"];
  failed: boolean;
  retry: () => unknown;
  failure?: { updatedAt: number; retry: () => unknown };
  waiting: boolean;
  initialWaiting: boolean;
  runtime: ReturnType<typeof useChartRuntime>;
  onRange: (range: Range) => void;
  /** Today's moves by position, listed under the 1D figure. */
  dayAttribution?: DashboardLens["dayAttribution"];
  windowAttribution?: DashboardLens["windowAttribution"];
  previousDay?: number | null;
}) {
  const t = useCopy();
  const { range, scope } = selection;
  const history = data?.history ?? selectPortfolioHistory({ range, scope });
  const { points } = history;
  const isIntraday = history.source === "intraday";
  const money = data?.money ?? portfolioMoney([], scope);
  // The 1D figure is today's: the positions behind it follow, as the five-day window's do.
  const attribution = range === "1D" ? dayAttribution : range === "1W" ? windowAttribution : undefined;
  const lines = [{ name: t("净盈亏", "Net P&L"), values: money.pnls, area: true }];
  const drivers = attribution ? dayDrivers({
    attribution,
    scope,
    day: history.endDay,
    dates: points.map((p) => p.date),
    pnls: money.pnls,
    openings: data?.openings,
    cutOff: history.pendingCashFlows,
  }) : null;
  return (
    <Panel
      className="mx-overview-history"
      title={t("区间净盈亏", "Period P&L")}
      help={<>
        <HistoryHelp />
        {range === "1D" && <Facts rows={[[
          t("上一交易日收益", "Previous trading day"),
          <span key="previous" className={previousDay == null ? undefined : "mx-" + tone(previousDay)}>
            {percent(previousDay, true, 2)}
          </span>,
        ]]} />}
      </>}
      action={
        <div className="mx-period-control">
          <PeriodSpan points={initialWaiting ? [] : points} reserve />
          {failure && <UpdateFailure {...failure} />}
          <DashboardRanges label={t("图表区间", "Chart range")} value={requestedRange} onChange={onRange} />
        </div>
      }
    >
      {initialWaiting || !data && !failed ? (
        <Pending shape="chart" height={326} quiet={initialWaiting} label={t("正在读取 ", "Loading ") +
          rangeName(requestedRange, t("全部", "all")) + t(" 盈亏记录…", " P&L history…")} />
      ) : runtime.status === "failed" ? (
        <QueryError retry={runtime.retry} />
      ) : !data ? (
        <div className="mx-overview-unavailable mx-overview-unavailable-history">
          <InlineRetry label={t("盈亏记录暂不可用", "P&L history unavailable")} retry={retry} />
        </div>
      ) : (
        <div className="mx-data-body" aria-busy={waiting && !failed || undefined}>
          {range !== requestedRange && <p className="mx-prior-range">
            {t("当前显示 ", "Showing ")}{rangeName(range, t("全部", "all"))}
          </p>}
          <div className="mx-period-figure">
            <strong className={money.pnl == null ? undefined : "mx-" + tone(money.pnl)}>
              {currency(money.pnl, "GBP", 2)}
            </strong>
            {money.pnl != null && (
              <span title={t("区间净盈亏 ÷ 期初账户价值", "Period net P&L divided by opening account value")}>
                {percent(money.pnlPercents.at(-1), true, 2)}
              </span>
            )}
            <TextLink href={portfolioPerformanceHref(scope, range)}>
              <ChartLine size={14} />
              {t("收益分析", "View performance")}
            </TextLink>
          </div>
          {drivers && <DayDrivers span={range === "1W" ? "5D" : "1D"} drivers={drivers} />}
          <HistoryCoverage history={history} />
          <TimelineChart
            dates={points.map((p) => p.date)}
            layers={[{ label: t("净盈亏", "Net P&L"), lines, zeroBaseline: true }]}
            label={t("区间净盈亏曲线", "Period net profit and loss over time")}
            intraday={isIntraday}
            range={range}
            timeline={history.timeline}
            observations={points}
            pendingCashFlows={history.pendingCashFlows}
            showHistoryEvidence={false}
            height={264}
            tooltip={{
              range: range === "1W" ? "5D" : range === "ALL" ? t("全部", "All") : range,
              unit: "GBP",
              primary: [{ label: t("区间净盈亏", "Period P&L"), values: money.pnls, signed: true }],
              secondary: [],
            }}
          />
        </div>
      )}
    </Panel>
  );
}
