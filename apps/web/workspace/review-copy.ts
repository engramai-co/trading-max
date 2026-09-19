import { currency, number, percent } from "./data";

type Copy = (zh: string, en: string) => string;
const diagnostics: Record<string, [string, string, "money" | "ratio" | "days"]> = {
  best_trade_dependence: ["最佳交易占盈利比", "Best-trade share of profits", "ratio"],
  largest_loss_share: ["最大亏损占总亏损比", "Largest-loss share", "ratio"],
  short_holding_share: ["七天内交易比例", "Trades closed within seven days", "ratio"],
  winner_vs_loser_holding_days: ["输家减赢家中位持有天数", "Loser minus winner median holding days", "days"],
  buy_notional_during_money_drawdown_gbp: ["回撤期间买入金额", "Purchases during drawdowns", "money"],
  drawdown_buy_notional: ["回撤期间买入金额", "Purchases during drawdowns", "money"],
};
export function behaviorObservation(diagnostic: string, value: unknown, t: Copy) {
  const entry = diagnostics[diagnostic];
  return {
    label: entry ? t(entry[0], entry[1]) : t("其他行为观测", "Other observation"),
    value: entry?.[2] === "money" ? currency(value, "GBP", 2)
      : entry?.[2] === "ratio" ? percent(value)
      : entry?.[2] === "days" ? number(value) + (value == null ? "" : t(" 天", " days"))
      : number(value),
    known: !!entry,
  };
}

const labels: Record<string, [string, string]> = {
  long: ["做多", "Long"], short: ["做空", "Short"], unknown: ["未分类", "Unclassified"],
  same_day: ["当日平仓", "Same day"], under_1_hour: ["少于 1 小时", "Under 1 hour"],
  same_day_1_to_24_hours: ["1–24 小时", "1–24 hours"],
  "1_to_7_days": ["1–7 天", "1–7 days"], "2_to_7_days": ["2–7 天", "2–7 days"],
  "8_to_30_days": ["8–30 天", "8–30 days"], "31_to_90_days": ["31–90 天", "31–90 days"],
  "31_days_or_more": ["31 天及以上", "31 days or more"], over_30_days: ["超过 30 天", "Over 30 days"], over_90_days: ["超过 90 天", "Over 90 days"],
  Transaction: ["资金划转", "Transfer"], "Closed position": ["平仓", "Closed position"],
  "Overnight interest": ["隔夜利息", "Overnight interest"], "Dividend adjustment": ["股息调整", "Dividend adjustment"],
  Monday: ["周一", "Monday"], Tuesday: ["周二", "Tuesday"], Wednesday: ["周三", "Wednesday"],
  Thursday: ["周四", "Thursday"], Friday: ["周五", "Friday"], Saturday: ["周六", "Saturday"], Sunday: ["周日", "Sunday"],
  gross_trade_result: ["交易毛收益", "Gross trading result"], transaction_fees: ["交易费用", "Transaction fees"],
  net_realised_result: ["净收益", "Net result"], authoritative: ["已核对", "Reconciled"],
  partial: ["部分覆盖", "Partial coverage"], reconstructed: ["历史估算", "Reconstructed"],
  unallocated_costs: ["待归属费用与调整", "Unallocated costs and adjustments"],
};
export function reviewLabel(value: string, t: Copy) {
  const entry = labels[value];
  return entry ? t(...entry) : value.includes("_") ? t("未分类", "Unclassified") : value;
}

export function systemReason(raw: string, t: Copy): string {
  const rules: Array<[RegExp, string]> = [
    [/fee_breakdown_unavailable/i, t("缺少可靠的费用换算记录，费用拆分暂不可用；已知的净盈亏仍正常展示。", "Fee conversion evidence is incomplete; the fee breakdown is unavailable while known net P&L remains visible.")],
    [/monetary_data_unavailable/i, t("原始记录缺少计算净额所需的金额或费用，相关结果暂不可用。", "Source records lack amounts or fees needed to calculate the net result.")],
    [/missing.*fx|fx.*unavailable|settlement.*conversion|exchange.rate.*unavailable/i, t("部分交易缺少可靠的历史汇率，相关英镑金额暂不可用。", "Some transactions lack reliable historical exchange rates; affected GBP amounts are unavailable.")],
    [/conflict.*cost|cost.*conflict|ambiguous.*cost|overlap.*cost/i, t("费用记录存在重叠或冲突，相关盈亏需核对后才能显示。", "Cost records overlap or conflict; affected P&L requires reconciliation.")],
    [/winning closed/i, t("还没有盈利的已平仓交易。", "No profitable closed trades are available.")],
    [/losing closed|non-zero gross loss/i, t("还没有亏损的已平仓交易，无法计算此指标。", "This metric needs at least one losing closed trade.")],
    [/closed campaigns|closed campaign|campaign columns/i, t("缺少完整的开平仓记录，暂不能分析已实现交易结果。", "Complete opening and closing records are needed to analyze closed trades.")],
    [/normalized transactions|without transactions/i, t("缺少交易流水，暂不能计算换手与交易行为。", "Transaction history is needed to calculate turnover and trading behavior.")],
    [/exposure dimension|metadata.*realised/i, t("现有持仓缺少这项分类资料。", "This classification is missing from the available records.")],
    [/no positive market value/i, t("没有市值为正的期末持仓。", "No ending holdings have positive market value.")],
    [/daily broker equity|open-position MTM|open-position snapshot|mark-to-market equity/i, t("缺少每日账户权益和未平仓估值，暂不能计算完整收益与风险。", "Daily account equity and open-position valuations are needed for full return and risk metrics.")],
    [/at least two|insufficient.*observations/i, t("有效历史记录不足。", "There are too few valid historical observations.")],
    [/positive opening capital|gross deposits/i, t("期初本金或入金不足以计算收益比例。", "Positive opening capital or deposits are required for this ratio.")],
    [/money outcome|valid NAV|valid date or value|finite GBP/i, t("缺少可核对的账户价值记录。", "Valid account-value records are unavailable.")],
    [/levered FCF proxy/i, t("现金流模型采用提供方的股权自由现金流估计。", "The model uses the provider’s equity free-cash-flow estimate.")],
    [/raw beta (.+) was capped at (.+) for/i, t("折现率计算对极端 Beta 做了限幅。", "Extreme beta values were capped for the discount-rate estimate.")],
    [/missing total revenue/i, t("缺少营业收入。", "Revenue is unavailable.")],
    [/missing shares outstanding/i, t("缺少流通股数。", "Shares outstanding are unavailable.")],
    [/missing revenue growth/i, t("缺少营收增长数据。", "Revenue growth is unavailable.")],
    [/missing free cash-flow margin/i, t("缺少自由现金流率。", "Free-cash-flow margin is unavailable.")],
    [/required valuation inputs/i, t("估值所需数据不完整。", "Required valuation inputs are incomplete.")],
  ];
  const match = rules.find(([pattern]) => pattern.test(raw));
  return match ? match[1] : t("这项分析存在数据限制。", "This analysis has a data limitation.");
}
