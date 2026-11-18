import type { components } from "@/lib/api-schema";
import type { DecisionAccount, ReviewScope, ScopedDecision } from "./review-board";
import type { Horizon } from "./review-decisions";

export const habitLabels = {
  before_earnings: ["财报前一周买入", "Buys before earnings"],
  untraded_fall: ["持仓大跌当天没加仓", "Large falls without a trade"],
  basket_buy: ["同一天买入多只", "Same-day basket buys"],
} as const;
export type Habit = keyof typeof habitLabels;
export const isHabit = (value: string | null | undefined): value is Habit =>
  !!value && Object.hasOwn(habitLabels, value);
export const toolScope = (scope: Exclude<ReviewScope, "C">) =>
  scope === "all" ? "broker_total" : scope === "A" ? "invest" : "isa";
export const toolHorizon = (horizon: Horizon) => (horizon === "date" ? "to_date" : "20_sessions");
export function habitDecisions(rows: ScopedDecision[], habit: Habit | null) {
  if (!habit) return rows;
  if (habit === "untraded_fall") return [];
  return rows.filter(
    (row) => row.side === "buy" && (habit === "before_earnings" ? row.beforeEarnings : row.basketBuy),
  );
}
type Evidence = components["schemas"]["InvestmentReviewEvidence"];
export function fallObservations(evidence: Evidence | undefined | null, accounts: DecisionAccount[]) {
  return accounts.flatMap((account) =>
    (evidence?.accounts?.[account]?.holdingMoves ?? [])
      .filter((move) => move.change < 0)
      .map((move) => ({ ...move, account })),
  );
}

export function decisionContext(
  row: ScopedDecision,
  rows: ScopedDecision[],
  scope: Exclude<ReviewScope, "C">,
  horizon: Horizon,
  habit: Habit | null,
) {
  const twins = rows.filter(
    (candidate) =>
      candidate.account === row.account &&
      candidate.date === row.date &&
      candidate.side === row.side &&
      candidate.ticker === row.ticker,
  );
  return {
    scope: toolScope(row.account),
    page_scope: toolScope(scope),
    horizon: toolHorizon(horizon),
    habit,
    ticker: row.ticker,
    decision_date: row.date,
    side: row.side,
    ordinal: twins.indexOf(row),
  };
}
