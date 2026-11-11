import { currency } from "@/workspace/data";

const gbp = (value: number) => currency(value, "GBP", 2);
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2, useGrouping: false });
const pence = (value: number) => Math.round(Number(decimal.format(value)) * 100);

function moneyTerm(value: number) {
  return { operator: value <= -0.005 ? "−" : "+", amount: gbp(Math.abs(value)) };
}

export function signedPnl(value: number | null) {
  if (value == null) return { amount: "—", tone: undefined };
  const { operator, amount } = moneyTerm(value);
  if (Math.abs(value) < 0.005) return { amount, tone: undefined };
  return { amount: operator + amount, tone: operator === "−" ? "down" as const : "up" as const };
}

export function moneyEquation({ opening, ending, contributions, pnl }: {
  opening: number | null;
  ending: number | null;
  contributions: number | null;
  pnl: number | null;
}) {
  if (opening == null || ending == null || contributions == null || pnl == null) return null;
  // Reconcile the underlying figures; a separately rounded penny can make
  // the displayed amounts approximate.
  return {
    opening: gbp(opening),
    contributions: moneyTerm(contributions),
    pnl: moneyTerm(pnl),
    operator: pence(opening) + pence(contributions) + pence(pnl) === pence(ending) ? "=" : "≈",
    ending: gbp(ending),
  };
}
