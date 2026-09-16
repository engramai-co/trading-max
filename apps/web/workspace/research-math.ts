/** Undefined and zero bases have no meaningful relative change. Losses use an absolute base. */
export function reportedGrowth(
  current: number | null,
  previous: number | null,
): number | null {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  )
    return null;
  return (current - previous) / Math.abs(previous);
}

/** Select by distance first, then display in strike order without mutating the source. */
export function nearMoneyStrikes(
  strikes: number[],
  spot: number,
  limit = 15,
): number[] {
  if (!Number.isFinite(spot) || spot <= 0) return [];
  return [...new Set(strikes)]
    .filter(Number.isFinite)
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)
    .slice(0, limit)
    .sort((a, b) => a - b);
}

/** A selected expiration must never silently inherit totals from all expirations. */
export function expirationSummary<T extends { expiry: string }>(
  expirations: T[],
  expiry: string,
): T | undefined {
  return expirations.find((row) => row.expiry === expiry);
}
