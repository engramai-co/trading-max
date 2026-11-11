"use client";

import { useLocale } from "@/components/locale-provider";
import type { Money } from "@/lib/portfolio/prepared";
import type { NavPoint } from "@/lib/types";
import { formatDate } from "@/ui/formatters";
import { EstimateTag } from "./history-coverage";
import { Metric, Tag, useCopy } from "./foundation";
import { moneyEquation, signedPnl } from "./money-readings";

export function MoneySummary({ money, points }: { money: Money; points: NavPoint[] }) {
  const t = useCopy();
  const pnl = signedPnl(money.pnl);
  const equation = moneyEquation(money);
  return (
    <div className="mx-money-summary">
      <Metric
        large
        label={<>{t("区间净盈亏", "Period net P&L")}<EstimateTag points={points} /></>}
        value={pnl.amount}
        tone={pnl.tone}
        helpLabel={t("区间净盈亏", "Period net P&L")}
        help={t(
          "净盈亏剔除出入金。“占期初价值 %”将金额变化除以期初价值，不是投资收益率。回撤按区间内净盈亏高点计算；修复状态以已有记录为准。点线跨过缺失记录，价值、盈亏与回撤曲线的虚线表示重建估算。现金流待核对时，图表和金额统一截至最后可核对时刻。",
          "Net P&L excludes deposits and withdrawals. “% of opening value” divides changes by the opening value; it is not an investment return. Drawdown is measured from the period P&L high, and recovery uses available records. Dotted lines bridge gaps; dashed sections of the value, P&L and drawdown lines show estimates. While cash flows are pending, charts and figures use the last verified cutoff.",
        )}
      />
      {equation && (
        <p className="mx-money-equation">
          <span>{t("期初", "Opening")} <strong>{equation.opening}</strong></span>{" "}
          <span>{equation.contributions.operator} {t("净入金", "Net contributions")} <strong>{equation.contributions.amount}</strong></span>{" "}
          <span>{equation.pnl.operator} {t("净盈亏", "Net P&L")} <strong>{equation.pnl.amount}</strong></span>{" "}
          <span>{equation.operator} {t("期末", "Ending")} <strong>{equation.ending}</strong></span>
        </p>
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
      <h3>{t("最大盈亏回撤", "Maximum P&L drawdown")}</h3>
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
