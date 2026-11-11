"use client";

import { Button } from "@mantine/core";
import { ArrowRight } from "@phosphor-icons/react";
import type { ComponentProps } from "react";
import { useLocale } from "@/components/locale-provider";
import type { Holding } from "@/lib/types";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { currency, number, percent, tone } from "./data";
import { signedPounds } from "./day-drivers";
import { Facts, Help, Instrument, Metric, useCopy } from "./foundation";
import { holdingQuantityUnit, holdingQuote } from "./holding-detail-data";
import Link from "./link";

function PositionMove({ label, amount, ratio }: {
  label: string;
  amount: number | null | undefined;
  ratio: number | null | undefined;
}) {
  const amountTone = tone(amount);
  const ratioTone = tone(ratio);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong className={amountTone && "mx-" + amountTone}>
          {amount == null ? "—" : signedPounds(amount)}
        </strong>
        {ratio != null && (
          <small>{" · "}<span className={ratioTone && "mx-" + ratioTone}>{percent(ratio, true, 2)}</span></small>
        )}
      </dd>
    </div>
  );
}

export function HoldingDetail({ holding, account, accountAsOf, today, now }: {
  holding: Holding;
  account: string;
  accountAsOf?: string | null;
  today: string;
  now: number;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const quote = holdingQuote(holding);
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
  const day = holding.dayChangeDate;
  const dayDate = day && formatCalendarDate(day, locale, now);
  // This is the account's attribution date, not the listing's closing date.
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
          <PositionMove label={dayLabel} amount={holding.dayChangeGbp} ratio={holding.dayChangePct} />
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
      <details className="mx-position-calculation">
        <summary>{t("报价与计算", "Quote and calculation")}</summary>
        <Facts rows={calculation} />
      </details>
      <div className="mx-position-actions">
        <Button component={Link} href={"/research?ticker=" + encodeURIComponent(holding.ticker)} rightSection={<ArrowRight size={16} />}>
          {t("研究这项投资", "Research this investment")}
        </Button>
        {holding.isFund && (
          <Button component={Link} variant="default" href="/holdings?view=lookthrough">
            {t("查看底层资产", "View look-through")}
          </Button>
        )}
      </div>
    </div>
  );
}
