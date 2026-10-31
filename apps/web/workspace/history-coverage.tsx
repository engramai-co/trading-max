"use client";

import { useLocale } from "@/components/locale-provider";
import type { NavPoint } from "@/lib/types";
import type { Locale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Freshness, Notice, Tag, useCopy } from "./foundation";
import type { PortfolioHistory } from "@/lib/portfolio/history";

/** Estimates change the conclusion when they set an endpoint or dominate the period. */
export const MATERIAL_ESTIMATE_SHARE = 0.25;

export function estimateCoverage(points: Array<Pick<NavPoint, "valuationSource">>) {
  const estimated = points.filter((point) => point.valuationSource === "reconstructed").length;
  const share = points.length ? estimated / points.length : 0;
  const opening = points[0]?.valuationSource === "reconstructed";
  const closing = points.at(-1)?.valuationSource === "reconstructed";
  return { estimated, share, opening, closing, material: opening || closing || share >= MATERIAL_ESTIMATE_SHARE };
}

/** The dates a period figure actually covers, e.g. "7月28日 – 10月28日". */
export function periodSpan(points: Array<Pick<NavPoint, "date">>, locale: Locale, timeZone: string) {
  const first = points[0]?.date;
  const last = points.at(-1)?.date;
  if (!first || !last) return "";
  const zone = (date: string) => (date.includes("T") ? timeZone : "UTC");
  const year = (date: string) => formatDate(date, locale, { year: "numeric", timeZone: zone(date) });
  const day = (date: string, withYear: boolean) =>
    formatDate(date, locale, { ...(withYear ? { year: "numeric" } : {}), month: "short", day: "numeric", timeZone: zone(date) });
  const start = day(first, year(first) !== year(last));
  const end = day(last, false);
  return start === end ? end : start + " – " + end;
}

export function PeriodSpan({ points }: { points: Array<Pick<NavPoint, "date">> }) {
  const { locale, timeZone } = useLocale();
  const span = periodSpan(points, locale, timeZone);
  return span ? <span className="mx-period-span">{span}</span> : null;
}

/** Quiet marker for minor estimates; HistoryCoverage speaks up when they are material. */
export function EstimateTag({ points }: { points: Array<Pick<NavPoint, "valuationSource">> }) {
  const t = useCopy();
  const coverage = estimateCoverage(points);
  if (!coverage.estimated || coverage.material) return null;
  return (
    <span title={t("依据交易、持仓与历史行情补算", "Reconstructed from transactions, holdings and historical prices")}>
      <Tag tone="warn">{t("含估算 ", "Includes estimates ") + Math.max(1, Math.round(coverage.share * 100)) + "%"}</Tag>
    </span>
  );
}

/** Only exceptions are written out: estimated endpoints, mostly estimated periods, pending cash flows. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  const { locale } = useLocale();
  const coverage = estimateCoverage(history.points);
  if (!history.pendingCashFlows && !coverage.material) return null;
  const share = Math.round(coverage.share * 100);
  return (
    <div className="mx-history-coverage" data-history-source={history.source}>
      {coverage.material && (
        <Notice tone="warn">
          {coverage.opening
            ? t("期初价值是重建估算，区间盈亏与回撤包含估算。", "The opening value is a reconstructed estimate; period P&L and drawdown include estimates.")
            : coverage.closing
              ? t("最新价值是重建估算，区间盈亏与回撤包含估算。", "The latest value is a reconstructed estimate; period P&L and drawdown include estimates.")
              : locale === "zh"
                ? `本区间 ${share}% 的价值是重建估算，区间盈亏与回撤包含估算。`
                : `${share}% of values in this period are reconstructed estimates; period P&L and drawdown include them.`}
        </Notice>
      )}
      {history.pendingCashFlows && (history.cashFlowCutoffAt
        ? <Freshness date={history.cashFlowCutoffAt} label={t("现金流待核对 · 统计截至", "Cash flows pending · Calculated through")} />
        : t("已有估值记录，资金流水待核对。", "Valuations are recorded; cash flows await reconciliation."))}
    </div>
  );
}

export function HistoryHelp() {
  const t = useCopy();
  return (
    <>
      <p>{t(
        "区间净盈亏 = 账户价值变化 − 区间净入金，以区间起点为零。金额包含现金与持仓变化，不是收益率；“相对期初”为净盈亏 ÷ 期初账户价值。",
        "Period net P&L is the change in account value less net deposits and withdrawals, starting at zero. It is a money amount, not a return rate; \"from opening\" divides it by the opening account value.",
      )}</p>
      <p>{t("虚线显示重建估算，点线连接仍未补齐的时段；悬停或轻点可查看每个值的来源。", "Dashed sections show reconstructed estimates; dotted sections bridge remaining gaps. Hover or tap to inspect each value's source.")}</p>
      <p>{t(
        "早期历史及离线期间可由交易、持仓与行情重建，区间盈亏和回撤也会包含估算。估算决定期初或最新价值，或占区间四分之一以上时，图上方会单独提示。现金流待核对时，本图与收益分析统一截至最后可核对时刻。",
        "Early history and collection outages can be reconstructed from transactions, holdings and prices; period P&L and drawdown then include estimates. A notice appears when an estimate sets the opening or latest value, or covers more than a quarter of the period. While cash flows await reconciliation, this chart and performance share the last verified cutoff.",
      )}</p>
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
    </>
  );
}
