import type { Holding } from "@/lib/types";

export function holdingSortDirection(sort: string, direction: string | null) {
  return direction === "asc" || direction === "desc"
    ? direction
    : sort === "ticker" ? "asc" : "desc";
}

export function compareHoldings(a: Holding, b: Holding, sort: string, direction: string) {
  const comparison = sort === "ticker" ? a.ticker.localeCompare(b.ticker)
    : sort === "pnl" ? a.pnlGbp - b.pnlGbp
    : sort === "allocation" ? a.allocationPct - b.allocationPct
    : a.currentValueGbp - b.currentValueGbp;
  return (direction === "asc" ? comparison : -comparison) || a.ticker.localeCompare(b.ticker);
}
