"use client";

import { Freshness, useCopy } from "./foundation";
import type { PortfolioHistory } from "@/lib/portfolio/history";

/** Missing observations are conveyed by the dashed stroke, not another status row. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  if (!history.pendingCashFlows) return null;
  return (
    <div className="mx-history-coverage" data-history-source={history.source}>
      <Freshness date={history.points.at(-1)?.date} label={t("现金流待核对 · 统计截至", "Cash flows pending · Calculated through")} />
    </div>
  );
}

export function HistoryHelp() {
  const t = useCopy();
  return (
    <>
      <p>{t(
        "区间净盈亏 = 账户价值变化 − 区间净入金，以区间起点为零。金额包含现金与持仓变化，不是收益率。",
        "Period net P&L is the change in account value less net deposits and withdrawals, starting at zero. It includes cash and holdings changes and is a money amount, not a return rate.",
      )}</p>
      <p>{t("虚线连接未采样时段，悬停显示已有记录。", "Dashed sections connect unrecorded intervals; hover shows recorded observations.")}</p>
      <p>{t(
        "部分早期历史由持仓与行情重建。现金流待核对时，本图与收益分析统一截至最后可核对时刻。",
        "Some earlier history is reconstructed from holdings and market prices. While cash flows await reconciliation, this chart and performance share the last verified cutoff.",
      )}</p>
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
    </>
  );
}
