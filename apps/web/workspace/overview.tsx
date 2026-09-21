"use client";

import { Button, Select } from "@mantine/core";
import {
  ArrowRight,
  ArrowUpRight,
  ChartLine,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo } from "react";
import { useDashboardLens } from "@/lib/dashboard-lenses";
import type { DashboardLens, Holding } from "@/lib/types";
import { TimelineChart } from "./timeline-chart";
import { currency, percent, tone } from "@/workspace/data";
import { type Scope } from "@/lib/portfolio/nav";
import {
  Empty,
  Freshness,
  Instrument,
  Metric,
  Notice,
  Page,
  Panel,
  Pending,
  QueryError,
  Segments,
  Tag,
  TextLink,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName, useWorkspaceProfile } from "./profile";
import { Narrative } from "./narrative";
import { HistoryCoverage, HistoryHelp } from "./history-coverage";
import { PORTFOLIO_RANGES, portfolioPerformanceHref, portfolioRange, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { usePortfolioHistory } from "@/lib/portfolio-history-query";

export function OverviewWorkspace() {
  const t = useCopy();
  const query = useDashboardLens("overview", undefined, true, { detail: "summary" });
  return (
    <Page
      className="mx-overview-page"
      title={t("组合总览", "Portfolio overview")}
      actions={
        <Button
          component={Link}
          href="/holdings"
          variant="default"
          rightSection={<ArrowRight size={15} />}
        >
          {t("查看持仓", "View holdings")}
        </Button>
      }
    >
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
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
  const day =
    scope === "total" ? data.latestModelDayReturn : selected?.dailyReturn;
  const signals = (data.technical ?? [])
    .filter((s) => holdings.some((h) => h.ticker === s.ticker))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
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
              label={t("总资产 · GBP", "PORTFOLIO VALUE · GBP")}
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
              <Metric
                label={t("上一交易日收益", "Previous daily return")}
                value={percent(day, true, 2)}
                tone={tone(day)}
                help={t("已核对现金流的日收益", "Cash-flow-aware daily return")}
              />
            </div>
          </div>
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
          <OverviewHistory scope={scope} runId={data.runId} />
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
                <span className="mx-account-letter">{account.code}</span>
                <div>
                  <strong style={{ fontSize: 13 }}>
                    {accountName(profile, account.code)}
                  </strong>
                  <div className="mx-metric-note">
                    {account.code === "A"
                      ? t("普通投资账户", "General investment")
                      : t("免税投资账户", "Stocks & shares ISA")}
                  </div>
                </div>
              </div>
              <div className="mx-row-value">
                {currency(account.totalValueGbp, "GBP", 2)}
                <small>
                  <span className={"mx-" + tone(account.unrealizedPnlGbp)}>
                    {currency(account.unrealizedPnlGbp)}
                  </span>{" "}
                  {t("浮动盈亏", "unrealized")}
                </small>
              </div>
              <ArrowUpRight size={17} />
            </Link>
          ))}
          {data.cfd && (
            <div className="mx-chart-footer">
              <span>
                CFD ·{" "}
                {t("历史现金权益", "Historical cash equity")}
              </span>
              <TextLink href="/account-analysis?account=C">
                {currency(data.cfd.endingValueGbp)}
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
          action={
            <TextLink href="/research">{t("研究台", "Research")}</TextLink>
          }
        >
          {signals.length ? (
            signals.map((signal) => {
              const valuation = data.valuations?.find(
                (v) => v.ticker === signal.ticker,
              );
              const name = holdings.find(
                (h) => h.ticker === signal.ticker,
              )?.name;
              return (
                <Link
                  className="mx-row-link"
                  key={signal.ticker}
                  href={"/research?ticker=" + encodeURIComponent(signal.ticker)}
                >
                  <Instrument ticker={signal.ticker} name={name} small />
                  <div className="mx-row-value">
                    {signal.score}
                    <span className="mx-metric-note"> / 100</span>
                    <small>
                      {valuation?.ev5Upside != null
                        ? t("模型空间 ", "Model upside ") +
                          percent(valuation.ev5Upside, true)
                        : t("技术评分", "Technical score")}
                    </small>
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
function OverviewHistory({ scope, runId }: { scope: Scope; runId: string }) {
  const t = useCopy();
  const { params, update } = useRouteState();
  const range = portfolioRange(params.get("range"));
  const selection = useMemo(() => ({ range, scope, runId }), [range, scope, runId]);
  const query = usePortfolioHistory(selection);
  const history = query.data?.history ?? selectPortfolioHistory({ range, scope });
  const { points } = history;
  const isIntraday = history.source === "intraday";
  const money = query.data?.money ?? portfolioMoney([], scope);
  const lines = [{ name: t("净盈亏", "Net P&L"), values: money.pnls, area: true }];
  return (
    <Panel
      className="mx-overview-history"
      title={t("区间净盈亏", "Period P&L")}
      help={<HistoryHelp />}
      action={
        <Segments
          label={t("图表区间", "Chart range")}
          value={range}
          onChange={(value) => update({ range: value })}
          options={PORTFOLIO_RANGES.map(
            (v) => ({
              value: v,
              label: v === "ALL" ? t("全部", "All") : v === "1W" ? "5D" : v,
            }),
          )}
        />
      }
    >
      {query.isPending ? (
        <Pending compact />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          <HistoryCoverage history={history} />
          <TimelineChart
            dates={points.map((p) => p.date)}
            layers={[{ label: t("净盈亏", "Net P&L"), lines, zeroBaseline: true }]}
            label={t("区间净盈亏曲线", "Period net profit and loss over time")}
            intraday={isIntraday}
            range={range}
            timeline={history.timeline}
            observations={points}
            recordSource={selection}
            tooltip={{
              range: range === "1W" ? "5D" : range === "ALL" ? t("全部", "All") : range,
              unit: "GBP",
              primary: [{ label: t("区间净盈亏", "Period P&L"), values: money.pnls, signed: true }],
              secondary: [],
            }}
          />
          <div className="mx-chart-footer">
            <span>
              {t("区间净盈亏", "Period P&L")}{" "}
              <strong>{currency(money.pnl, "GBP", 2)}</strong>
            </span>
            <TextLink href={portfolioPerformanceHref(scope, range)}>
              <ChartLine size={14} />
              {t("收益分析", "View performance")}
            </TextLink>
          </div>
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
      action={
        <Tag>{rows.length}{t(" 个标的", " securities")}</Tag>
      }
      description={t(
        "按已投资市值 · 不含现金",
        "Share of invested assets · cash excluded",
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
          {t("穿透 ETF，查看底层资产", "Look inside your ETFs")}
        </TextLink>
      </div>
    </Panel>
  );
}
