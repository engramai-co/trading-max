"use client";

import { useLocale } from "@/components/locale-provider";
import type { ReactNode } from "react";
import type { NavPoint } from "@/lib/types";
import type { Locale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Freshness, Help, Tag, useCopy } from "./foundation";
import { DataBasis } from "./reading-card";
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

export function PeriodSpan({ points, reserve = false }: { points: Array<Pick<NavPoint, "date">>; reserve?: boolean }) {
  const { locale, timeZone } = useLocale();
  const span = periodSpan(points, locale, timeZone);
  return span ? <span className="mx-period-span">{span}</span> : reserve
    ? <span className="mx-period-span mx-period-span-reserved" aria-hidden="true">&nbsp;</span>
    : null;
}

/**
 * Estimates are marked once, beside the period figure, with the chart's dashed stroke.
 * The tag takes the warning tone and is the figure's only help trigger: it opens the
 * estimate note followed by the figure's own explanation, for keyboard and touch as well.
 */
export function EstimateTag({ points, children }: { points: Array<Pick<NavPoint, "valuationSource">>; children?: ReactNode }) {
  const t = useCopy();
  const coverage = estimateCoverage(points);
  if (!coverage.estimated) return null;
  const share = Math.max(1, Math.round(coverage.share * 100));
  const label = coverage.opening
    ? t("期初为估算", "Estimated opening")
    : coverage.closing
      ? t("最新为估算", "Estimated latest")
      : t("含估算 ", "Includes estimates ") + share + "%";
  const detail = coverage.opening
    ? t("期初价值是估算，按交易、持仓和行情重建；区间净盈亏与回撤因此包含估算。", "The opening value is an estimate, reconstructed from trades, holdings and prices, so period net P&L and drawdown include estimates.")
    : coverage.closing
      ? t("最新价值是估算，按交易、持仓和行情重建；区间净盈亏与回撤因此包含估算。", "The latest value is an estimate, reconstructed from trades, holdings and prices, so period net P&L and drawdown include estimates.")
      : t("部分价值依据交易、持仓与历史行情补算，区间净盈亏与回撤包含估算。", "Some values are reconstructed from transactions, holdings and historical prices; period net P&L and drawdown include them.");
  return (
    <Help
      label={label}
      tag={
        <Tag tone="warn">
          <svg width="14" height="4" aria-hidden="true">
            <line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3" />
          </svg>
          {label}
        </Tag>
      }
    >
      <p>{detail}</p>
      {children}
    </Help>
  );
}

/** Pending cash flows are the one coverage exception written out; estimates are tagged beside the figure. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  if (!history.pendingCashFlows) return null;
  return (
    <div className="mx-history-coverage mb-4 min-w-0" data-history-source={history.source}>
      {history.cashFlowCutoffAt
        ? <Freshness date={history.cashFlowCutoffAt} label={t("出入金待核对 · 统计截至", "Deposits and withdrawals pending · Calculated through")} />
        : t("已有估值记录，出入金待核对。", "Valuations are recorded; deposits and withdrawals await reconciliation.")}
    </div>
  );
}

type Cutoff = Pick<PortfolioHistory, "pendingCashFlows" | "cashFlowCutoffAt">;

/** "Through 09:00" for a figure that stops at its cash-flow cutoff, in the display time zone. */
export function cutoffLabel(history: Cutoff, locale: Locale, timeZone: string) {
  if (!history.pendingCashFlows) return null;
  const at = history.cashFlowCutoffAt;
  if (!at) return locale === "zh" ? "出入金待核对" : "Deposits and withdrawals pending";
  const time = formatDate(at, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return (locale === "zh" ? "截至 " : "Through ") + time;
}

/** The amber cutoff beside a short-range figure; the figure's own help explains it. */
export function CutoffTag({ history }: { history: Cutoff }) {
  const { locale, timeZone } = useLocale();
  const label = cutoffLabel(history, locale, timeZone);
  return label ? <Tag tone="warn">{label}</Tag> : null;
}

/** The basis line every portfolio history help ends with: where values come from and how gaps are filled. */
export function HistoryBasis() {
  const t = useCopy();
  return (
    <DataBasis>
      {t(
        "账户价值来自券商约每 10 分钟一次的记录；缺少记录的时段按交易、持仓和行情重建为估算，图中用虚线表示，点线跨过缺失记录。出入金待核对时，图表和金额统一截至最后可核对时刻；每个时点的来源和精度在收益分析的精确记录里。",
        "Account value comes from broker records about every 10 minutes. Missing periods are reconstructed from trades, holdings and prices as estimates, drawn dashed; dotted lines bridge gaps. While deposits and withdrawals await reconciliation, charts and figures stop at the last verified time. Each point’s source and precision is in the exact records under Returns.",
      )}
    </DataBasis>
  );
}

export function HistoryHelp() {
  const t = useCopy();
  return (
    <>
      <p>{t(
        "区间净盈亏 = 账户价值变化 − 区间净入金，从区间起点的 0 开始。它是金额，不是收益率；“相对期初”是净盈亏 ÷ 期初价值。",
        "Period net P&L is the change in account value less net deposits, starting from zero. It is an amount, not a return; \"vs opening\" divides it by the opening value.",
      )}</p>
      <p>{t(
        "1D 的数字下方是今日变动最大的持仓，按全天持有的股数计算，与“其他”相加等于账户变化；持仓价格解释不了的变化标为“未归因”。5D 为最近 5 个工作日，月度区间按自然月，图中省略周末。",
        "On 1D, the largest holding moves today sit under the figure, counting shares held all day; with \"Other\" they add up to the account change, and moves prices do not explain show as \"Unattributed\". 5D covers five weekdays; monthly ranges follow calendar months, with weekends omitted.",
      )}</p>
      <HistoryBasis />
    </>
  );
}
