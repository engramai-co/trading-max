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

/**
 * Each day change carries the trading day its own account was measured on. The
 * column names the latest one; a change from an earlier day reports that day.
 */
export function dayChangeColumn(holdings: Holding[]) {
  const readingDate = (h: Holding) => h.dayChangeClosedOn ?? (h.dayChangeGbp != null ? h.dayChangeDate : null);
  const latest = holdings
    .map(readingDate)
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1) ?? null;
  const earlier = (h: Holding) => {
    const date = readingDate(h);
    return date && latest && date !== latest ? date : null;
  };
  return { latest, earlier };
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
