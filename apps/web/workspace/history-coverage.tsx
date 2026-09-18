"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { Freshness, useCopy } from "./foundation";
import type { PortfolioHistory } from "./portfolio-history";

/** Only incomplete coverage needs an extra status alongside the chart. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { coverage, timeline } = history;
  // The chart owns its empty state. Daily CFD context is shown with its account.
  if (history.source !== "intraday") return null;
  const incomplete = coverage.status !== "complete" && coverage.status !== "empty";
  if (!incomplete && !history.pendingCashFlows) return null;
  const day = history.startDay === history.endDay;
  const stamp = (value: string | null) => value ? formatDate(value, locale, {
    ...(day ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }), timeZone,
  }) : "—";
  const leading = coverage.gaps.some((gap) => gap.startIndex === 0);
  const internal = coverage.gaps.filter((gap) => gap.startIndex > 0 && gap.endIndex < timeline.categories.length - 1).length;
  const trailing = coverage.lastObservedIndex != null && coverage.lastObservedIndex < timeline.categories.length - 1;
  const detail = coverage.status === "single"
    ? t("仅有 {date} 的一条记录，尚不能计算变化。", "One observation at {date}; change is not yet available.").replace("{date}", stamp(coverage.firstObservedAt))
    : [
        leading && t("{date} 之前暂无数据", "No data before {date}").replace("{date}", stamp(coverage.firstObservedAt)),
        internal > 0 && t("{count} 段数据缺失", "{count} gaps in coverage").replace("{count}", String(internal)),
        trailing && t("记录截至 {date}", "Recorded through {date}").replace("{date}", stamp(coverage.lastObservedAt)),
      ].filter(Boolean).join(" · ");
  return (
    <div className="mx-history-coverage" data-history-source={history.source}>
      {history.pendingCashFlows && (
        <Freshness date={history.points.at(-1)?.date} label={t("现金流待核对 · 统计截至", "Cash flows pending · Calculated through")} />
      )}
      {incomplete && (
        <details className="mx-history-coverage-details">
          <summary>{coverage.status === "single" ? t("仅有一条记录", "One observation available") : t("部分时段缺少记录", "Some periods have no observations")}</summary>
          <p className="mx-history-coverage-detail">{detail}</p>
          {coverage.status === "partial" && <p className="mx-history-coverage-detail">{t(
            "曲线以虚线连接缺失区间两端，不补造估值。完整记录及来源可在图下查看。",
            "Dashed spans connect the ends of missing intervals without estimating values. Exact observations and sources are available below the chart.",
          )}</p>}
        </details>
      )}
    </div>
  );
}

export function HistoryHelp() {
  const t = useCopy();
  return (
    <>
      <p>{t(
        "账户估值包含现金与持仓，部分历史由持仓和行情重建。价值变化含出入金；投资收益请看“收益对比”。",
        "Account valuations include cash and holdings; some history is reconstructed from positions and market prices. Value changes include deposits and withdrawals. See Return comparison for investment returns.",
      )}</p>
      <p>{t("曲线的虚线段连接缺失区间两端的记录，不代表区间内有实测数据。", "Dashed spans connect records on either side of a gap; they are not observations within it.")}</p>
      <p>{t(
        "橙色虚线为累计净入金。现金流待核对时，本图与收益分析统一截至最后可核对时刻。",
        "Orange dashes show cumulative net contributions. While cash flows await reconciliation, this chart and performance share the last verified cutoff.",
      )}</p>
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
    </>
  );
}
