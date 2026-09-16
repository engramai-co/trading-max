/** Resolve only observed directory identities, preserving exchange ambiguity. */
export function resolveResearchIdentity<T extends { ticker: string }>(
  instruments: T[],
  requested: string,
): { selected: T | undefined; candidates: T[] } {
  const normalized = requested.trim().toUpperCase();
  const exact = instruments.find((item) => item.ticker.toUpperCase() === normalized);
  if (exact) return { selected: exact, candidates: [] };
  // A qualified symbol is an explicit market choice, never a bare-symbol alias.
  if (normalized.includes(".")) return { selected: undefined, candidates: [] };
  const aliases = instruments.filter((item) => item.ticker.toUpperCase() === normalized + ".L");
  if (!aliases.length) return { selected: undefined, candidates: [] };
  const candidates = instruments.filter((item) =>
    item.ticker.toUpperCase().startsWith(normalized + "."),
  );
  return candidates.length === 1
    ? { selected: candidates[0], candidates: [] }
    : { selected: undefined, candidates };
}
