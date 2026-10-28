"use client";

import { Freshness, useCopy } from "./foundation";
import type { PortfolioHistory } from "@/lib/portfolio/history";

/** Make the estimated basis explicit before charts and money statistics. */
export function HistoryCoverage({ history }: { history: PortfolioHistory }) {
  const t = useCopy();
  if (!history.pendingCashFlows && !history.reconstructedCount) return null;
  return (
    <div className="mx-history-coverage" data-history-source={history.source}>
      {history.reconstructedCount > 0 && <p>{t(
        "本区间含重建估算：依据交易、持仓及历史行情补算，盈亏和回撤也包含估算值，不等同于券商实测。",
        "This period includes estimates reconstructed from transactions, holdings and historical prices. P&L and drawdown include estimates, not just broker observations.",
      )}</p>}
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
        "区间净盈亏 = 账户价值变化 − 区间净入金，以区间起点为零。金额包含现金与持仓变化，不是收益率。",
        "Period net P&L is the change in account value less net deposits and withdrawals, starting at zero. It includes cash and holdings changes and is a money amount, not a return rate.",
      )}</p>
      <p>{t("虚线显示重建估算，点线连接仍未补齐的时段；悬停可查看每个值的来源。", "Dashed sections show reconstructed estimates; dotted sections bridge remaining gaps. Hover to inspect each value's source.")}</p>
      <p>{t(
        "早期历史及离线期间可由交易、持仓与行情重建，区间盈亏和回撤也会包含估算。现金流待核对时，本图与收益分析统一截至最后可核对时刻。",
        "Early history and collection outages can be reconstructed from transactions, holdings and prices; period P&L and drawdown then include estimates. While cash flows await reconciliation, this chart and performance share the last verified cutoff.",
      )}</p>
      <p>{t(
        "5D 为最近 5 个工作日；月度区间按自然月，图中省略周末。完整记录及来源可在图下展开查看。",
        "5D covers five weekdays. Monthly ranges use calendar months with weekends omitted from the chart. Expand the records below for individual observations and sources.",
      )}</p>
    </>
  );
}
