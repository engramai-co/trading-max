import type { Holding } from "@/lib/types";

export const HOLDING_SORTS = ["value", "day", "pnl", "allocation", "ticker"] as const;
export type HoldingSort = (typeof HOLDING_SORTS)[number];

export function holdingSort(value: string | null): HoldingSort {
  return HOLDING_SORTS.find((sort) => sort === value) ?? "value";
}

export function holdingSortDirection(sort: string, direction: string | null) {
  return direction === "asc" || direction === "desc"
    ? direction
    : sort === "ticker" ? "asc" : "desc";
}

export function compareHoldings(a: Holding, b: Holding, sort: string, direction: string) {
  if (sort === "day") {
    // Today's change in GBP. A position without one (opened today, or no
    // attribution yet) stays last in either direction.
    const left = a.dayChangeGbp ?? null;
    const right = b.dayChangeGbp ?? null;
    if (left == null || right == null) {
      return left == null && right == null ? a.ticker.localeCompare(b.ticker) : left == null ? 1 : -1;
    }
    return (direction === "asc" ? left - right : right - left) || a.ticker.localeCompare(b.ticker);
  }
  const comparison = sort === "ticker" ? a.ticker.localeCompare(b.ticker)
    : sort === "pnl" ? a.pnlGbp - b.pnlGbp
    : sort === "allocation" ? a.allocationPct - b.allocationPct
    : a.currentValueGbp - b.currentValueGbp;
  return (direction === "asc" ? comparison : -comparison) || a.ticker.localeCompare(b.ticker);
}
