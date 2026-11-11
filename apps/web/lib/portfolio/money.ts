import type { NavPoint } from "@/lib/types";
import { difference, navNumber, type Scope } from "@/lib/portfolio/nav";
import { drawdowns, minimumObserved } from "@/lib/portfolio/math";

type DrawdownObservation = {
  date: string;
  estimated: boolean;
};

export type DrawdownEpisode = {
  peak: DrawdownObservation;
  trough: DrawdownObservation;
  recovery: DrawdownObservation | null;
};

/** Locate the worst decline and its first recorded recovery on the full series. */
function drawdownEpisode(
  points: NavPoint[],
  drawdown: Array<number | null>,
  maximum: number | null,
): DrawdownEpisode | null {
  if (maximum == null || maximum >= 0) return null;
  const trough = drawdown.indexOf(maximum);
  // A zero is an observed high. Ties use the last observation at that high.
  const peak = drawdown.lastIndexOf(0, trough - 1);
  const recovery = drawdown.indexOf(0, trough + 1);
  const observation = (index: number) => ({
    date: points[index].date,
    estimated: points[index].valuationSource === "reconstructed",
  });
  return { peak: observation(peak), trough: observation(trough), recovery: recovery < 0 ? null : observation(recovery) };
}

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
  const maxDrawdown = complete ? minimumObserved(drawdown) : null;
  return {
    opening,
    ending: navNumber(points.at(-1), scope),
    contributions: points.length > 1 ? periodFlows.at(-1) ?? null : null,
    pnl: points.length > 1 ? pnls.at(-1) ?? null : null,
    maxDrawdown,
    drawdownEpisode: drawdownEpisode(points, drawdown, maxDrawdown),
    pnls,
    pnlPercents: relative(pnls),
    drawdown,
    drawdownPercents: relative(drawdown),
    periodFlows,
    valueChanges,
    valueChangePercents: relative(valueChanges),
  };
}
