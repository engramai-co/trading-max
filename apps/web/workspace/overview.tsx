"use client";

import { Button, Select } from "@mantine/core";
import { ArrowUpRight, ChartLine } from "@phosphor-icons/react";
import Link from "./link";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, Holding, RefreshAttention } from "@/lib/types";
import { TimelineChart } from "./timeline-chart";
import { api, currency, percent, tone } from "@/workspace/data";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { attentionItems, type AttentionFact, type AttentionItem } from "./attention";
import { type Range, type Scope } from "@/lib/portfolio/nav";
import {
  Empty,
  Facts,
  Freshness,
  Instrument,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Segments,
  TextLink,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { Narrative } from "./narrative";
import { CutoffTag, EstimateTag, HistoryCoverage, HistoryHelp, PeriodSpan } from "./history-coverage";
import { DayDrivers, dayDrivers, signedPounds } from "./day-drivers";
import { PORTFOLIO_RANGES, historyDay, portfolioPerformanceHref, preferredRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";
import { LocalOnboarding } from "./local-onboarding";
import { SecurityPeek } from "./security-peek";

/** The overview chart reopens on the range last chosen on this device; a range in the URL wins. */
const RANGE_STORAGE_KEY = "trading_max-overview-range";
function subscribeToStorage(notify: () => void) {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
}
function storedRange() {
  try {
    return window.localStorage.getItem(RANGE_STORAGE_KEY);
  } catch {
    return null;
  }
}
function useRememberedRange() {
  const remembered = useSyncExternalStore(subscribeToStorage, storedRange, () => null);
  const remember = useCallback((range: Range) => {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Private browsing without storage still switches the range for this view.
    }
  }, []);
  return [remembered, remember] as const;
}

export function OverviewWorkspace({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  const query = useDashboardLens("overview", undefined, true, { detail: "summary" });
  return (
    <Page className="mx-overview-page" title={t("组合总览", "Portfolio overview")}>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        localWorkspace ? <LocalOnboarding showAccountLink /> : <QueryError retry={query.refetch} />
      ) : (
        query.data && <OverviewContent data={query.data} />
      )}
    </Page>
  );
}
function OverviewContent({ data }: { data: DashboardLens }) {
  const t = useCopy();
  const { data: profile } = useWorkspaceProfile();
  const { params, update } = useRouteState();
  const [now] = useState(() => Date.now());
  const refresh = useQuery({
    queryKey: ["refresh-attention"],
    queryFn: ({ signal }) => api<RefreshAttention>("/refresh/attention", { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const scope: Scope =
    params.get("scope") === "invest"
      ? "invest"
      : params.get("scope") === "isa"
        ? "isa"
        : "total";
  const accounts = (data.accounts ?? []).filter((a) => a.isInvestable);
  const selected = accounts.find(
    (a) => a.code === (scope === "invest" ? "A" : scope === "isa" ? "B" : ""),
  );
  const holdings = (data.holdings ?? []).filter(
    (h) => scope === "total" || h.account === (scope === "invest" ? "A" : "B"),
  );
  if (!accounts.length && data.totalValueGbp == null)
    return (
      <Panel>
        <Empty
          title={t("暂无账户数据", "No account data")}
          description={t(
            "连接 Trading 212 账户，完成首次同步后即可查看资产和投资表现。",
            "Connect a Trading 212 account and sync once to see your investments here.",
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
    scope === "total" ? data.totalUnrealizedPnlGbp : selected?.unrealizedPnlGbp;
  const cash = scope === "total" ? data.totalCashGbp : selected?.cashGbp;
  const value =
    scope === "total" ? data.totalValueGbp : selected?.totalValueGbp;
  const previousDay =
    scope === "total" ? data.latestModelDayReturn : selected?.dailyReturn;
  // A retired account with nothing left in it has no row; history stays in review.
  const cfd = data.cfd && !(data.cfd.accountStatus === "retired" && Math.abs(data.cfd.endingValueGbp ?? 0) < 0.005)
    ? data.cfd
    : null;
  const signals = (data.technical ?? [])
    .filter((s) => s.score != null && holdings.some((h) => h.ticker === s.ticker))
    .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity))
    .slice(0, 3);
  const attention = attentionItems({
    holdings,
    technical: data.technical,
    valuations: data.valuations,
    brokerAsOf: data.brokerAsOf,
    refresh: refresh.data,
    now,
  });
  return (
    <>
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
              value={scope}
              onChange={(v) => update({ scope: v === "total" ? null : v })}
            />
            <Freshness date={data.brokerAsOf} />
          </div>
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
                label={t("可用现金", "Cash balance")}
                value={currency(cash, "GBP", 2)}
              />
              <TodayMetric
                scope={scope}
                runId={data.runId}
                attribution={data.dayAttribution}
                previousDay={previousDay}
                now={now}
              />
            </div>
          </div>
          <Attention items={attention} />
        </section>
        {scope !== "total" && !selected && (
          <div className="mx-overview-notice">
            <Notice>
              {t(
                "这份快照还没有该账户的数据。请检查账户连接并完成更新。",
                "This snapshot has no data for this account. Check its connection and run an update.",
              )}
            </Notice>
          </div>
        )}
        <div className="mx-overview-split">
          <OverviewHistory
            scope={scope}
            runId={data.runId}
            windowAttribution={data.windowAttribution}
          />
          <Allocation holdings={holdings} />
        </div>
      </div>
      <div className="mx-panel mx-overview-followups mx-overview-split">
        <Panel
          className="mx-overview-accounts"
          title={t("账户", "Accounts")}
        >
          {accounts.map((account) => (
            <Link
              className="mx-row-link"
              href={"/account-analysis?account=" + account.code}
              key={account.code}
            >
              <div className="mx-account-title">
                <strong style={{ fontSize: 13 }}>
                  {accountName(profile, account.code)}
                </strong>
              </div>
              <div className="mx-row-value">
                {currency(account.totalValueGbp, "GBP", 2)}
                <small>
                  <span className={"mx-" + tone(account.unrealizedPnlGbp)}>
                    {currency(account.unrealizedPnlGbp)}
                  </span>
                </small>
              </div>
              <ArrowUpRight size={17} />
            </Link>
          ))}
          {cfd && (
            <div className="mx-chart-footer">
              <span>
                CFD ·{" "}
                {t("历史现金权益", "Historical cash equity")}
              </span>
              <TextLink href="/account-analysis?account=C">
                {currency(cfd.endingValueGbp)}
              </TextLink>
            </div>
          )}
        </Panel>
        <Panel
          className="mx-overview-research"
          title={t("持仓研究", "Holdings research")}
          help={t(
            "当前账户持仓中，按技术评分从低到高展示最多三个已有研究的标的。",
            "Up to three researched holdings in the selected account, ordered by technical score from low to high.",
          )}
        >
          {signals.length ? (
            signals.map((signal) => {
              const valuation = data.valuations?.find(
                (v) => v.ticker === signal.ticker,
              );
              const name = holdings.find(
                (h) => h.ticker === signal.ticker,
              )?.name;
              const held = holdings.filter((h) => h.ticker === signal.ticker);
              return (
                <Link
                  className="mx-row-link"
                  key={signal.ticker}
                  href={"/research?ticker=" + encodeURIComponent(signal.ticker)}
                >
                  <SecurityPeek
                    ticker={signal.ticker}
                    position={{
                      valueGbp: held.reduce((sum, h) => sum + h.currentValueGbp, 0),
                      weightPct: held.reduce((sum, h) => sum + h.allocationPct, 0),
                    }}
                  >
                    <Instrument ticker={signal.ticker} name={name} small />
                  </SecurityPeek>
                  <div className="mx-row-value">
                    {t("技术 ", "Technical ")}{signal.score}
                    <span className="mx-metric-note">/100</span>
                    {valuation?.ev5Upside != null && (
                      <small>
                        {t("模型空间 ", "Model upside ") +
                          percent(valuation.ev5Upside, true)}
                      </small>
                    )}
                  </div>
                  <ArrowUpRight size={16} />
                </Link>
              );
            })
          ) : (
            <Empty
              title={t("暂无研究数据", "No research data")}
              description={t(
                "添加标的并更新研究后，相关线索会出现在这里。",
                "Add securities and update research to surface their latest context.",
              )}
              action={
                <TextLink href="/research">
                  {t("进入研究台", "Open research")}
                </TextLink>
              }
            />
          )}
        </Panel>
      </div>
      <Narrative snapshot={data.runId} lens="daily_cio_brief" page="overview" />
    </>
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
  const fact = (f: AttentionFact) => {
    if (f.kind === "score") return zh ? `技术 ${f.value}/100` : `Technical ${f.value}/100`;
    if (f.kind === "rsi") {
      const stretched = f.value >= 75 ? (zh ? "超买" : "overbought") : zh ? "超卖" : "oversold";
      return `RSI ${f.value} ${stretched}`;
    }
    if (f.kind === "upside") return zh ? `模型空间 ${percent(f.value, true, 0)}` : `Model upside ${percent(f.value, true, 0)}`;
    return zh ? `浮亏 ${percent(Math.abs(f.value), false, 0)}` : `${percent(f.value, true, 0)} vs cost`;
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
        ) : item.kind === "stale" ? (
          <Link key="stale" href="/health" data-tone="warning">
            {age(item.hours)}
          </Link>
        ) : (
          <Link key={item.ticker} href={item.href} data-tone={item.facts[0].kind === "rsi" ? "warning" : "down"}>
            <strong>{item.ticker}</strong>
            <span>{item.facts.map(fact).join(" · ")}</span>
          </Link>
        ),
      )}
    </nav>
  );
}
/** What today did to the account, and the positions behind it; the 1D chart's own figure. */
function TodayMetric({
  scope,
  runId,
  attribution,
  previousDay,
  now,
}: {
  scope: Scope;
  runId: string;
  attribution?: DashboardLens["dayAttribution"];
  previousDay?: number | null;
  now: number;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const selection = useMemo(() => ({ range: "1D" as const, scope, runId }), [scope, runId]);
  const query = usePortfolioHistory(selection);
  const history = query.data?.history;
  const money = query.data?.money;
  const points = history?.points ?? [];
  const day = history?.endDay;
  const pnl = money?.pnl ?? null;
  const share = money?.pnlPercents.at(-1) ?? null;
  // On a weekend or before the day's first observation the window is an earlier
  // trading day: name it instead of calling it today.
  const label = !day || day === historyDay(new Date(now).toISOString())
    ? t("今日", "Today")
    : formatCalendarDate(day, locale, now);
  // The drivers explain this figure only, so they wait while it stops at a cutoff.
  const drivers = attribution && money && history ? dayDrivers({
    attribution,
    scope,
    day,
    dates: points.map((p) => p.date),
    pnls: money.pnls,
    cutOff: history.pendingCashFlows,
  }) : null;
  return (
    <Metric
      label={<>{label}{history && <CutoffTag history={history} />}</>}
      helpLabel={label}
      value={pnl == null ? "—" : (
        <>
          {signedPounds(pnl)}
          {share != null && <small className="mx-metric-change">{percent(share, true, 2)}</small>}
          <EstimateTag points={points} />
        </>
      )}
      tone={tone(pnl)}
      help={(
        <>
          {history?.pendingCashFlows && (
            <p>
              {t(
                "新的现金流待核对：数字统计至最后可核对的记录，核对完成后更新，届时再列出变动最大的持仓。",
                "New cash flows await reconciliation: the figure stops at the last verified record and catches up once they are reconciled; the largest position moves follow then.",
              )}
            </p>
          )}
          <p>
            {t(
              "本交易日第一条账户记录以来的净盈亏，已扣除当日出入金；下面列出变动最大的持仓。",
              "Net P&L since the trading day's first account observation, excluding money moved in or out that day; the largest position moves follow.",
            )}
          </p>
          <Facts rows={[[
            t("上一交易日收益", "Previous trading day"),
            <span key="previous" className={previousDay == null ? undefined : "mx-" + tone(previousDay)}>
              {percent(previousDay, true, 2)}
            </span>,
          ]]} />
        </>
      )}
      note={drivers ? <DayDrivers drivers={drivers} /> : undefined}
    />
  );
}
function OverviewHistory({
  scope,
  runId,
  windowAttribution,
}: {
  scope: Scope;
  runId: string;
  windowAttribution?: DashboardLens["windowAttribution"];
}) {
  const t = useCopy();
  const { params, update } = useRouteState();
  const [remembered, remember] = useRememberedRange();
  const range = preferredRange(params.get("range"), remembered);
  const selection = useMemo(() => ({ range, scope, runId }), [range, scope, runId]);
  const query = usePortfolioHistory(selection);
  const history = query.data?.history ?? selectPortfolioHistory({ range, scope });
  const { points } = history;
  const isIntraday = history.source === "intraday";
  const money = query.data?.money ?? portfolioMoney([], scope);
  const lines = [{ name: t("净盈亏", "Net P&L"), values: money.pnls, area: true }];
  const drivers = range === "1W" && windowAttribution ? dayDrivers({
    attribution: windowAttribution,
    scope,
    day: history.endDay,
    dates: points.map((p) => p.date),
    pnls: money.pnls,
    cutOff: history.pendingCashFlows,
    span: "5D",
  }) : null;
  return (
    <Panel
      className="mx-overview-history"
      title={t("区间净盈亏", "Period P&L")}
      help={<HistoryHelp />}
      action={
        <div className="mx-period-control">
          <PeriodSpan points={points} />
          <Segments
            label={t("图表区间", "Chart range")}
            value={range}
            onChange={(value) => {
              remember(value);
              update({ range: value });
            }}
            shortcuts
            options={PORTFOLIO_RANGES.map(
              (v) => ({
                value: v,
                label: v === "ALL" ? t("全部", "All") : v === "1W" ? "5D" : v,
              }),
            )}
          />
        </div>
      }
    >
      {query.isPending ? (
        <Pending compact />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          <div className="mx-period-figure">
            <strong className={money.pnl == null ? undefined : "mx-" + tone(money.pnl)}>
              {currency(money.pnl, "GBP", 2)}
            </strong>
            {money.pnl != null && (
              <span title={t("区间净盈亏 ÷ 期初账户价值", "Period net P&L divided by opening account value")}>
                {percent(money.pnlPercents.at(-1), true, 2)}
              </span>
            )}
            <EstimateTag points={points} />
            <TextLink href={portfolioPerformanceHref(scope, range)}>
              <ChartLine size={14} />
              {t("收益分析", "View performance")}
            </TextLink>
          </div>
          {drivers && <DayDrivers span="5D" drivers={drivers} />}
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
            recordSource={selection}
            tooltip={{
              range: range === "1W" ? "5D" : range === "ALL" ? t("全部", "All") : range,
              unit: "GBP",
              primary: [{ label: t("区间净盈亏", "Period P&L"), values: money.pnls, signed: true }],
              secondary: [],
            }}
          />
        </>
      )}
    </Panel>
  );
}
function Allocation({ holdings }: { holdings: Holding[] }) {
  const t = useCopy();
  const grouped = new Map<
    string,
    { ticker: string; name: string; value: number }
  >();
  for (const h of holdings) {
    const current = grouped.get(h.ticker);
    grouped.set(h.ticker, {
      ticker: h.ticker,
      name: h.name,
      value: (current?.value ?? 0) + h.currentValueGbp,
    });
  }
  const rows = [...grouped.values()].sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const shown = rows.slice(0, 5);
  const other = rows.slice(5).reduce((sum, r) => sum + r.value, 0);
  return (
    <Panel
      className="mx-overview-allocation"
      title={t("持仓分布", "Holdings allocation")}
      help={t(
        "按已投资市值计算占比，不含现金。",
        "Shares of invested value; cash is excluded.",
      )}
    >
      <div className="mx-stack-bar" aria-hidden="true">
        {[...shown.map((r) => r.value), other]
          .filter((v) => v > 0)
          .map((v, i) => (
            <span
              key={i}
              style={{
                width: percent(total > 0 ? v / total : 0),
                background: "var(--mx-chart-" + i + ")",
              }}
            />
          ))}
      </div>
      <div className="mx-overview-allocation-list">
        {shown.map((row, index) => (
          <Link
            className="mx-allocation-row"
            key={row.ticker}
            href={"/research?ticker=" + encodeURIComponent(row.ticker)}
          >
            <span className="mx-allocation-name">
              <i
                aria-hidden="true"
                style={{ background: `var(--mx-chart-${index})` }}
              />
              <span>
                <strong>{row.ticker}</strong>
                <small>{row.name}</small>
              </span>
            </span>
            <div className="mx-row-value">
              {percent(total > 0 ? row.value / total : null)}
              <small>{currency(row.value)}</small>
            </div>
          </Link>
        ))}
        {other > 0 && (
          <div className="mx-allocation-row">
            <span className="mx-allocation-name">
              <i
                aria-hidden="true"
                style={{ background: "var(--mx-chart-5)" }}
              />
              {t("其他持仓", "Other holdings")}
            </span>
            <span className="mx-row-value">
              {percent(other / total)}
              <small>{currency(other)}</small>
            </span>
          </div>
        )}
      </div>
      {!rows.length && <Empty title={t("还没有持仓", "No positions yet")} />}
      <div className="mx-allocation-foot">
        <TextLink href="/holdings?view=lookthrough">
          {t("穿透", "Look-through")}
        </TextLink>
      </div>
    </Panel>
  );
}
