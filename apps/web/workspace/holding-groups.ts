import type { DashboardLens, Holding } from "@/lib/types";

export type HoldingGroup = [Holding, ...Holding[]];

export const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function groupHoldings(holdings: Holding[]): Map<string, HoldingGroup> {
  const groups = new Map<string, HoldingGroup>();
  for (const holding of holdings) {
    const group = groups.get(holding.ticker);
    if (group) group.push(holding);
    else groups.set(holding.ticker, [holding]);
  }
  return groups;
}

export function combinedHoldingPnl(positions: HoldingGroup): number | null {
  const cost = positions.reduce((sum, h) => sum + (finite(h.costGbp) ?? 0), 0);
  const pnl = positions.reduce((sum, h) => sum + (finite(h.pnlGbp) ?? 0), 0);
  return cost > 0 ? pnl / cost : finite(positions[0].pnlPct);
}

export function isFundHolding(positions: HoldingGroup): boolean {
  return positions.some((holding) => holding.isFund);
}

/** Prefer the listing's research symbol; older snapshots may only have the display symbol. */
export function holdingTechnical(technical: DashboardLens["technical"], ticker: string, positions: HoldingGroup) {
  const researchTicker = positions[0].researchTicker;
  return technical?.find((row) => row.ticker === researchTicker)
    ?? technical?.find((row) => row.ticker === ticker);
}
