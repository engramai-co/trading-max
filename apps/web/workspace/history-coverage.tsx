"use client";

import { useLocale } from "@/components/locale-provider";
import type { NavPoint } from "@/lib/types";
import type { Locale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Freshness, Help, Tag, useCopy } from "./foundation";
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
 * Estimates are marked beside the period figure, with the chart's dashed stroke.
 * Minor estimates stay neutral; endpoints or a large share turn the tag amber. The
 * tag opens its explanation, for keyboard and touch as well as the pointer.
 */
export function EstimateTag({ points }: { points: Array<Pick<NavPoint, "valuationSource">> }) {
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
    ? t("期初价值是重建估算，区间盈亏与回撤包含估算。", "The opening value is a reconstructed estimate; period P&L and drawdown include estimates.")
    : coverage.closing
      ? t("最新价值是重建估算，区间盈亏与回撤包含估算。", "The latest value is a reconstructed estimate; period P&L and drawdown include estimates.")
      : t("部分价值依据交易、持仓与历史行情补算，区间盈亏与回撤包含估算。", "Some values are reconstructed from transactions, holdings and historical prices; period P&L and drawdown include them.");
  return (
    <Help
      label={label}
      tag={
        <Tag tone={coverage.material ? "warn" : "neutral"}>
          <svg width="14" height="4" aria-hidden="true">
            <line x1="1" y1="2" x2="13" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3" />
          </svg>
          {label}
        </Tag>
      }
    >
      {detail}
    </Help>
  );
}

/** Pending cash flows are the one coverage exception written out; estimates are tagged beside the figure. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  if (!history.pendingCashFlows) return null;
  return (
    <div className="mx-history-coverage" data-history-source={history.source}>
      {history.cashFlowCutoffAt
        ? <Freshness date={history.cashFlowCutoffAt} label={t("现金流待核对 · 统计截至", "Cash flows pending · Calculated through")} />
        : t("已有估值记录，资金流水待核对。", "Valuations are recorded; cash flows await reconciliation.")}
    </div>
  );
}

type Cutoff = Pick<PortfolioHistory, "pendingCashFlows" | "cashFlowCutoffAt">;

/** "Through 09:00" for a figure that stops at its cash-flow cutoff, in the display time zone. */
export function cutoffLabel(history: Cutoff, locale: Locale, timeZone: string) {
  if (!history.pendingCashFlows) return null;
  const at = history.cashFlowCutoffAt;
  if (!at) return locale === "zh" ? "现金流待核对" : "Cash flows pending";
  const time = formatDate(at, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return (locale === "zh" ? "截至 " : "Through ") + time;
}

/** The amber cutoff beside a short-range figure; the figure's own help explains it. */
export function CutoffTag({ history }: { history: Cutoff }) {
  const { locale, timeZone } = useLocale();
  const label = cutoffLabel(history, locale, timeZone);
  return label ? <Tag tone="warn">{label}</Tag> : null;
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
        "早期历史及离线期间可由交易、持仓与行情重建，区间盈亏和回撤也会包含估算，并在区间盈亏旁标注。估算决定期初或最新价值，或占区间四分之一以上时，标注转为提醒色。现金流待核对时，本图与收益分析统一截至最后可核对时刻。",
        "Early history and collection outages can be reconstructed from transactions, holdings and prices; period P&L and drawdown then include estimates, marked beside the period P&L. The mark turns amber when an estimate sets the opening or latest value, or covers more than a quarter of the period. While cash flows await reconciliation, this chart and performance share the last verified cutoff.",
      )}</p>
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
      <p>{t(
        "1D 的数字下方列出今天变动最大的持仓，按全天持有的股数计算；“其他”是其余部分，各项相加等于账户变化。持仓价格解释不了的较大变化（现金、汇率、当日买卖或估值时点）单独标为“未归因”。",
        "On 1D, the largest position moves today appear under the figure, counting shares held all day; \"Other\" is the rest, and the parts add up to the account change. A large change positions do not explain (cash, FX, trades during the day or valuation timing) is shown separately as \"Unattributed\".",
      )}</p>
    </>
  );
}
