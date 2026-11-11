export function moneyTimelineLayout(phone: boolean) {
  const [valueHeight, pnlHeight, drawdownHeight] = phone ? [140, 220, 110] : [176, 270, 130];
  const valueTop = 32;
  const pnlTop = valueTop + valueHeight + 46;
  const drawdownHeading = pnlTop + pnlHeight + 24;
  const drawdownTop = drawdownHeading + (phone ? 86 : 32);
  return {
    grids: [
      { top: valueTop, height: valueHeight },
      { top: pnlTop, height: pnlHeight },
      { top: drawdownTop, height: drawdownHeight },
    ],
    drawdownHeading,
    height: drawdownTop + drawdownHeight + 68,
  };
}

/** A zero-aligned axis with four or five P&L ticks, or two or three drawdown ticks. */
export function moneyAxis(values: Array<number | null>, drawdown: boolean, percentage: boolean) {
  let min = 0, max = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    if (!drawdown) max = Math.max(max, value);
  }
  if (min === 0 && max === 0) {
    if (drawdown) min = percentage ? -0.01 : -1;
    else max = percentage ? 0.01 : 1;
  } else {
    // A little room at a nonzero edge keeps the stroke visible.
    min *= 1.01;
    max *= 1.01;
  }

  const maxSplits = drawdown ? 2 : 4;
  const minSplits = maxSplits - 1;
  const magnitude = 10 ** Math.floor(Math.log10((max - min) / maxSplits));
  let best: { min: number; max: number; interval: number } | undefined;
  for (const multiple of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 20]) {
    const interval = multiple * magnitude;
    const below = Math.ceil(-min / interval);
    const above = Math.ceil(max / interval);
    if (below + above < minSplits || below + above > maxSplits) continue;
    const candidate = { min: below ? -below * interval : 0, max: above * interval, interval };
    const span = candidate.max - candidate.min;
    if (!best || span < best.max - best.min) best = candidate;
  }
  if (best) return best;

  // For mixed signs near a tick boundary, a fractional step can fall between
  // preferred multiples. Preserve zero and the extremes even in that case.
  const interval = (max - min) / minSplits;
  return { min: Math.floor(min / interval) * interval || 0, max: Math.ceil(max / interval) * interval, interval };
}
