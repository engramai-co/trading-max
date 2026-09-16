import type { NavPoint } from "@/lib/types";
import { difference, navNumber, type Scope } from "./data";
import { drawdowns, minimumObserved } from "./performance-math";

/** Same cash-flow-adjusted money basis at every valuation cadence. */
export function portfolioMoney(points: NavPoint[], scope: Scope) {
  const opening = navNumber(points[0], scope);
  const openingFlows = navNumber(points[0], scope, "NetContributionsGbp");
  const periodFlows = points.map((point) => difference(openingFlows, navNumber(point, scope, "NetContributionsGbp")));
  const valueChanges = points.map((point) => difference(opening, navNumber(point, scope)));
  const pnls = valueChanges.map((value, i) => value != null && periodFlows[i] != null ? value - periodFlows[i]! : null);
  const relative = (values: Array<number | null>) => values.map((value) => value != null && opening != null && opening > 0 ? value / opening : null);
  const drawdown = drawdowns(pnls);
  const complete = pnls.length > 1 && pnls.every((value) => value != null);
  return {
    opening,
    ending: navNumber(points.at(-1), scope),
    contributions: points.length > 1 ? periodFlows.at(-1) ?? null : null,
    pnl: points.length > 1 ? pnls.at(-1) ?? null : null,
    maxDrawdown: complete ? minimumObserved(drawdown) : null,
    pnls,
    pnlPercents: relative(pnls),
    drawdown,
    drawdownPercents: relative(drawdown),
    periodFlows,
    valueChanges,
    valueChangePercents: relative(valueChanges),
  };
}
