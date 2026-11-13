"use client";

import { Button } from "@mantine/core";
import { ArrowRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { useLocale } from "@/components/locale-provider";
import type { Holding } from "@/lib/types";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { currency, number, percent, tone } from "./data";
import { ClosedMarket } from "./closed-market";
import { signedPounds } from "./day-drivers";
import { Facts, Help, Instrument, Metric, Tag, useCopy } from "./foundation";
import { etfDetailQuery, etfPortfolioQuery, fieldEvidence, findETF, overlapDisplay, trackingDisplay } from "./etf-data";
import { researchLensQuery } from "./research-queries";
import { EvidenceReading } from "./etf-reading";
import { holdingQuantityUnit, holdingQuote } from "./holding-detail-data";
import Link from "./link";

function PositionMove({ label, amount, ratio, closed }: {
  label: string;
  amount: number | null | undefined;
  ratio: number | null | undefined;
  closed?: boolean;
}) {
  const amountTone = tone(amount);
  const ratioTone = tone(ratio);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong className={!closed && amountTone ? "mx-" + amountTone : undefined}>
          {closed ? <ClosedMarket /> : amount == null ? "—" : signedPounds(amount)}
        </strong>
        {!closed && ratio != null && (
          <small>{" · "}<span className={ratioTone && "mx-" + ratioTone}>{percent(ratio, true, 2)}</span></small>
        )}
      </dd>
    </div>
  );
}

export function HoldingDetail({ holding, account, accountAsOf, runId, today, now }: {
  holding: Holding;
  account: string;
  accountAsOf?: string | null;
  runId?: string;
  today: string;
  now: number;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const quote = holdingQuote(holding);
  const researchHref = "/research?ticker=" + encodeURIComponent(holding.researchTicker ?? holding.ticker);
  const rate = holding.snapshotFxRateNativePerGbp;
  const calculation: ComponentProps<typeof Facts>["rows"] = [
    [t("原始报价", "Raw quote"), quote.raw],
  ];
  if (quote.pence) calculation.push([t("单位换算", "Unit conversion"), "100 GBX = £1"]);
  if (quote.foreign) {
    calculation.push(
      [t("快照隐含汇率", "Implied FX rate"), rate != null && Number.isFinite(rate) && rate > 0
        ? `1 GBP = ${rate.toFixed(4)} ${holding.priceCurrency}`
        : "—"],
      [t("汇率影响", "FX impact"), currency(holding.fxImpactGbp, "GBP", 2)],
    );
  }
  calculation.push([
    t("账户快照", "Account snapshot"),
    accountAsOf ? <time dateTime={accountAsOf}>{formatDateTime(accountAsOf, locale, timeZone, now)}</time> : "—",
  ]);
  const day = holding.dayChangeClosedOn ?? holding.dayChangeDate;
  const dayDate = day && formatCalendarDate(day, locale, now);
  // The numeric move uses the account's date; a closure uses the exchange's date.
  const dayLabel = !dayDate ? t("当日变动", "Day change") : day === today
    ? t("今日", "Today")
    : locale === "zh" ? `${dayDate}变动` : `${dayDate} change`;
  const listing = holding.listingMarket === "US" ? t("美国", "US") : holding.listingMarket ?? undefined;
  const unit = holdingQuantityUnit(holding.isFund, locale, holding.quantity);
  const quantity = number(holding.quantity, 5);
  const weight = percent(holding.allocationPct);
  const dilutedCostLabel = holding.isFund ? t("摊薄成本 / 份", "Diluted cost / unit") : t("摊薄成本 / 股", "Diluted cost / share");
  return (
    <div className="mx-position-detail">
      <Instrument
        ticker={holding.ticker}
        name={holding.name}
        listing={listing}
        detail={<span className="mx-position-account">{account}</span>}
      />
      <div className="mx-position-impact">
        <div className="mx-position-value">
          <Metric large label={t("当前市值", "Current market value")} value={currency(holding.currentValueGbp, "GBP", 2)} />
          <span className="mx-position-weight">{locale === "zh" ? `占组合 ${weight}` : `${weight} of portfolio`}</span>
        </div>
        <dl className="mx-position-moves">
          <PositionMove label={dayLabel} amount={holding.dayChangeGbp} ratio={holding.dayChangePct} closed={Boolean(holding.dayChangeClosedOn)} />
          <PositionMove label={t("浮动盈亏", "Unrealized P&L")} amount={holding.pnlGbp} ratio={holding.pnlPct} />
        </dl>
      </div>
      <Facts rows={[
        [t("持有数量", "Quantity"), quantity === "—" ? quantity : `${quantity} ${unit}`],
        [t("当前价格", "Current price"), quote.price],
        [t("买入总成本", "Total purchase cost"), currency(holding.costGbp, "GBP", 2)],
        [
          <span key="diluted-cost" className="mx-position-cost-label">
            {dilutedCostLabel}
            <Help label={t("摊薄成本", "Diluted cost")}>
              {t("计入已实现交易与回收资金，可能不同于券商买入均价。", "Includes realized trades and recovered capital; it may differ from broker purchase cost.")}
            </Help>
          </span>,
          quote.dilutedCost,
        ],
      ]} />
      {holding.isFund && runId ? <FundPosition holding={holding} runId={runId} />
        : !holding.isFund && <NextStockEvent ticker={holding.ticker} runId={runId} today={today} now={now} />}
      <details className="mx-position-calculation">
        <summary>{t("报价与计算", "Quote and calculation")}</summary>
        <Facts rows={calculation} />
      </details>
      <div className="mx-position-actions">
        <Button component={Link} href={researchHref} rightSection={<ArrowRight size={16} />}>
          {t("研究这项投资", "Research this investment")}
        </Button>
        {holding.isFund && (
          <Button component={Link} variant="default" href={researchHref + "&view=fundamentals"}>
            {t("查看底层资产", "View look-through")}
          </Button>
        )}
      </div>
    </div>
  );
}


function NextStockEvent({ ticker, runId, today, now }: { ticker: string; runId?: string; today: string; now: number }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { data } = useQuery(researchLensQuery(ticker, "overview", runId, "summary"));
  const date = data?.nextEarningsDate;
  if (!date || date < today) return null;
  const label = t("下次财报", "Next earnings");
  return <Facts rows={[[label, <time key="earnings" dateTime={date} title={t("研究快照", "Research snapshot") + " · " + data.generatedAt}>{formatCalendarDate(date, locale, now)}</time>]]} />;
}

function FundPosition({ holding, runId }: { holding: Holding; runId: string }) {
  const t = useCopy();
  const portfolio = useQuery({ ...etfPortfolioQuery(runId), enabled: !holding.fundIsin });
  const summary = portfolio.data?.runId === runId ? findETF(portfolio.data.funds, holding.ticker) : undefined;
  const isin = holding.fundIsin || summary?.isin || "";
  const detail = useQuery({ ...etfDetailQuery(runId, isin), enabled: Boolean(isin) });
  const current = detail.data?.runId === runId ? detail.data : undefined;
  const reading = current?.reading ?? summary;
  const tracking = trackingDisplay(reading, t);
  const overlap = overlapDisplay(reading, t);
  const missing = t("暂无", "Unavailable");
  const fee = reading?.expenseRatio == null ? missing : percent(reading.expenseRatio, false, 2);
  const feeLabel = reading?.feeBasis === "OCF" ? t("持续费用率", "Ongoing charge") : t("总费用率", "Total expense ratio");
  const feeEvidence = fieldEvidence(feeLabel, fee, reading?.evidence?.expense_ratio, t);
  const holdings = current?.holdings;
  const top = [...(holdings?.holdings ?? [])].filter((item) => item.weightPct > 0)
    .sort((a, b) => b.weightPct - a.weightPct).slice(0, 10);
  return (
    <>
      <Facts rows={[
        [t("跟踪指数", "Tracked index"), reading?.indexName || missing],
        [feeLabel, <span key="fee" role="group" title={feeEvidence} aria-label={feeEvidence}>{fee}</span>],
        [t("收益分配", "Income use"), reading?.incomeUse === "Accumulating" ? t("累积", "Accumulating")
          : reading?.incomeUse === "Distributing" ? t("派息", "Distributing") : reading?.incomeUse ?? missing],
        [t("一年跟踪差", "1-year tracking difference"), <EvidenceReading key="tracking" {...tracking} />],
        [t("组合重叠", "Portfolio overlap"), <EvidenceReading key="overlap" {...overlap} />],
      ]} />
      <details className="mx-position-calculation">
        <summary>{t("基金底层持仓", "Underlying holdings")}</summary>
        {reading?.holdingsState === "holdings-stale" && <Tag tone="warn">{t("持仓已过期", "Holdings stale")}</Tag>}
        {top.length ? <Facts rows={top.map((item) => {
          const weight = percent(item.weightPct / 100, false, 2);
          const basis = [reading?.issuer, holdings?.evidence?.holdings?.sourceUrl,
            t("发行商持仓权重", "Issuer holdings weight") + " " + weight, holdings?.asOf].filter(Boolean).join(" · ");
          return [item.name || item.ticker || item.isin,
            <span key={item.isin || item.name} role="group" title={basis} aria-label={basis}>{weight}</span>];
        })} /> : <p role="status">{
          detail.isFetching || portfolio.isFetching ? t("正在读取已发布持仓…", "Loading published holdings…")
            : reading?.holdingsState === "data-failed" || detail.isError ? t("持仓数据读取失败", "Holdings data failed")
            : t("暂无持仓披露", "No holdings disclosure")
        }</p>}
      </details>
    </>
  );
}
