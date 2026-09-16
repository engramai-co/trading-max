"use client";

import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { useCopy } from "./foundation";
import type { PortfolioHistory } from "./portfolio-history";

/** Only incomplete coverage needs an extra status alongside the chart. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { coverage, timeline } = history;
  // The chart owns its empty state. Daily CFD context is shown with its account.
  if (history.source !== "intraday" || coverage.status === "complete" || coverage.status === "empty") return null;
  const day = history.startDay === history.endDay;
  const stamp = (value: string | null) => value ? formatDate(value, locale, {
    ...(day ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }), timeZone,
  }) : "—";
  const leading = coverage.gaps.some((gap) => gap.startIndex === 0);
  const internal = coverage.gaps.filter((gap) => gap.startIndex > 0).length;
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
      <p className="mx-history-coverage-detail" role="status">{detail}</p>
      {coverage.status === "partial" && (
        <div className="mx-history-coverage-track" aria-hidden="true">
          {coverage.observedRanges.map((span) => (
            <span key={span.startIndex} style={{
              left: `${span.startIndex / timeline.categories.length * 100}%`,
              width: `${(span.endIndex - span.startIndex + 1) / timeline.categories.length * 100}%`,
            }} />
          ))}
        </div>
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
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
    </>
  );
}
