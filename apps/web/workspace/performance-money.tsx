"use client";

import { useLocale } from "@/components/locale-provider";
import type { Money } from "@/lib/portfolio/prepared";
import type { NavPoint } from "@/lib/types";
import { formatDate } from "@/ui/formatters";
import { EstimateTag, HistoryBasis, estimateCoverage } from "./history-coverage";
import { Metric, Tag, useCopy } from "./foundation";
import { moneyEquation, signedPnl } from "./money-readings";

export function MoneySummary({ money, points }: { money: Money; points: NavPoint[] }) {
  const t = useCopy();
  const pnl = signedPnl(money.pnl);
  const equation = moneyEquation(money);
  const label = t("区间净盈亏", "Period net P&L");
  const help = (
    <>
      <p>{t(
        "净盈亏剔除出入金。“占期初价值 %”把金额变化除以期初价值，不是投资收益率。回撤从区间内净盈亏的高点算起，是否修复以已有记录为准。",
        "Net P&L excludes deposits and withdrawals. “% of opening value” divides changes by the opening value; it is not an investment return. Drawdown runs from the period’s P&L high, and recovery follows the available records.",
      )}</p>
      <HistoryBasis />
    </>
  );
  // With estimates, the amber tag is the figure's one help trigger; otherwise the figure keeps its own.
  const estimated = estimateCoverage(points).estimated > 0;
  return (
    <div className="mx-money-summary">
      <Metric
        large
        label={estimated ? <>{label}<EstimateTag points={points}>{help}</EstimateTag></> : label}
        value={pnl.amount}
        tone={pnl.tone}
        {...(estimated ? {} : { help, helpLabel: label })}
      />
      {equation && (
        <dl className="mx-money-equation">
          <div><dt>{t("期初价值", "Opening value")}</dt><dd>{equation.opening}</dd></div>
          <div><dt>{t("净入金", "Net deposits")}</dt><dd>{equation.contributions.operator} {equation.contributions.amount}</dd></div>
          <div><dt>{t("净盈亏", "Net P&L")}</dt><dd>{equation.pnl.operator} {equation.pnl.amount}</dd></div>
          <div><dt>{t("期末价值", "Ending value")}</dt><dd>{equation.operator} {equation.ending}</dd></div>
        </dl>
      )}
    </div>
  );
}

export function MoneyDrawdown({ money }: { money: Money }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { amount, tone } = signedPnl(money.maxDrawdown);
  const episode = money.drawdownEpisode;
  const zone = (date: string) => date.includes("T") ? timeZone : "UTC";
  const day = (date: string) => formatDate(date, locale, { month: "short", day: "numeric", timeZone: zone(date) });
  const peakDay = episode ? day(episode.peak.date) : "";
  const troughDay = episode ? day(episode.trough.date) : "";
  const recoveryDay = episode?.recovery ? day(episode.recovery.date) : "";
  const clock = peakDay === troughDay || (recoveryDay !== "" && recoveryDay === troughDay);
  const renderDate = (point: NonNullable<Money["drawdownEpisode"]>["peak"]) => (
    <span className="mx-money-event">
      <time dateTime={point.date}>
        {formatDate(point.date, locale, {
          year: "numeric", month: "short", day: "numeric", timeZone: zone(point.date),
          ...(clock && point.date.includes("T") ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
        })}
      </time>
      {point.estimated && <Tag tone="warn">{t("估算", "Estimate")}</Tag>}
    </span>
  );
  return (
    <div className="mx-money-drawdown">
      <h2>{t("最大盈亏回撤", "Max P&L drawdown")}</h2>
      <strong className={tone ? "mx-" + tone : undefined}>{amount}</strong>
      {episode && (
        <div className="mx-money-drawdown-dates">
          <span className="sr-only">{t("从高点到低点", "Peak to trough")}</span>
          {renderDate(episode.peak)}
          <span aria-hidden="true">→</span>
          {renderDate(episode.trough)}
          {episode.recovery
            ? <span className="mx-money-event">{t("已修复", "Recovered")} {renderDate(episode.recovery)}</span>
            : <span>{t("未修复", "Not recovered")}</span>}
        </div>
      )}
    </div>
  );
}
