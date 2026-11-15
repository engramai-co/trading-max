export type DrawdownEpisode = {
  peak: number;
  trough: number;
  depth: number;
  recovery: number | null;
  state: "recovered" | "open" | "interrupted";
};

/** Identify episodes on a drawdown series that was already calculated on the
 * chosen peak domain. A missing observation cannot prove a recovery. */
export function drawdownEpisodes(values: ReadonlyArray<number | null>) {
  const episodes: DrawdownEpisode[] = [];
  let peak = -1;
  let active: DrawdownEpisode | null = null;
  for (let index = 0; index < values.length; index++) {
    const depth = values[index];
    if (depth == null || !Number.isFinite(depth)) {
      if (active) episodes.push({ ...active, state: "interrupted" });
      active = null;
      peak = -1;
    } else if (depth >= 0) {
      if (active) episodes.push({ ...active, recovery: index, state: "recovered" });
      active = null;
      peak = index;
    } else if (peak >= 0) {
      if (!active || depth < active.depth) active = { peak, depth, trough: index, recovery: null, state: "open" };
    }
  }
  if (active) episodes.push(active);
  return episodes;
}

export function deepestDrawdown(values: ReadonlyArray<number | null>) {
  return drawdownEpisodes(values).reduce<DrawdownEpisode | undefined>((deepest, entry) =>
    !deepest || entry.depth < deepest.depth ? entry : deepest, undefined);
}
