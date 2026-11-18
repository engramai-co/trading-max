type Anchor = {date: string; number: number; x: number; high: number};

// Three 18px markers and their hit areas fit above a candle at the plot ceiling.
export const markerHeadroom = 80;

export function placeMarkers(points: Anchor[], height: number) {
  const placed: (Anchor & {y: number})[] = [];
  for (const point of [...points].sort((a,b) => a.high-b.high)) {
    const initial = Math.max(10, Math.min(height - 10, point.high - 13));
    const nearby = placed.filter(other => Math.abs(other.x - point.x) < 28);
    const candidates = [initial, ...nearby.flatMap(other => [other.y - 28, other.y + 28])];
    const available = candidates.filter(candidate => candidate >= 10 && candidate <= height - 10 &&
      nearby.every(other => Math.abs(other.y - candidate) >= 28))
      .sort((a, b) => Math.abs(a - initial) - Math.abs(b - initial) || a - b);
    const y = available.find(candidate => candidate + 9 < point.high);
    if (y !== undefined) placed.push({...point, y});
  }
  return placed.sort((a,b) => a.number-b.number);
}
