import type { SectorGroup, SectorMarketCode, SectorSessionWindow } from "@/lib/types";

/** Markets in the order the page lists them. */
export const SECTOR_MARKETS: readonly SectorMarketCode[] = ["us", "uk", "hk", "kr"];

export function sectorMarket(value: string | null | undefined): SectorMarketCode | null {
  return SECTOR_MARKETS.find((market) => market === value) ?? null;
}

/** Exchange suffixes add nothing inside one market's board. */
export function displaySymbol(symbol: string) {
  return symbol.replace(/\.(HK|KS|KQ|L)$/i, "");
}

const SMALL_WORDS: Record<string, string> = { LTD: "Ltd", INC: "Inc", PLC: "plc", CO: "Co", CORP: "Corp" };

/** Issuer holdings files shout their names; read them in title case, keeping short acronyms. */
export function issuerName(name: string) {
  if (name !== name.toUpperCase()) return name;
  return name.split(/\s+/).map((word) => {
    if (SMALL_WORDS[word]) return SMALL_WORDS[word];
    if (word.length <= 3 || /\d/.test(word)) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  }).join(" ");
}

export type Rect = { x: number; y: number; w: number; h: number };
export type Tile<K extends string = string> = Rect & { key: K };

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): areas proportional to
 * weight, laid out in rows that keep each tile as close to square as possible.
 * Larger weights come first; non-positive weights take no space.
 */
export function squarify<K extends string>(items: ReadonlyArray<{ key: K; weight: number }>, rect: Rect): Tile<K>[] {
  const sorted = items.filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = sorted.map((item) => ({ key: item.key, area: item.weight * scale }));
  const tiles: Tile<K>[] = [];
  let free = { ...rect };
  let row: typeof areas = [];
  const worst = (cells: typeof areas, side: number) => {
    const sum = cells.reduce((total, cell) => total + cell.area, 0);
    const largest = Math.max(...cells.map((cell) => cell.area));
    const smallest = Math.min(...cells.map((cell) => cell.area));
    return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
  };
  const place = (cells: typeof areas) => {
    const sum = cells.reduce((total, cell) => total + cell.area, 0);
    if (free.w >= free.h) {
      const width = Math.min(free.w, sum / free.h);
      let y = free.y;
      for (const cell of cells) {
        const height = cell.area / width;
        tiles.push({ key: cell.key, x: free.x, y, w: width, h: height });
        y += height;
      }
      free = { x: free.x + width, y: free.y, w: Math.max(0, free.w - width), h: free.h };
    } else {
      const height = Math.min(free.h, sum / free.w);
      let x = free.x;
      for (const cell of cells) {
        const width = cell.area / height;
        tiles.push({ key: cell.key, x, y: free.y, w: width, h: height });
        x += width;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: Math.max(0, free.h - height) };
    }
  };
  for (const cell of areas) {
    const side = Math.min(free.w, free.h);
    if (row.length === 0 || worst([...row, cell], side) <= worst(row, side)) row.push(cell);
    else {
      place(row);
      row = [cell];
    }
  }
  if (row.length) place(row);
  return tiles;
}

export type Direction = "left" | "right" | "up" | "down";

/** The tile an arrow key reaches: the nearest centre in that direction, favouring the same row or column. */
export function neighbour(tiles: ReadonlyArray<Tile>, from: string, direction: Direction): string | null {
  const origin = tiles.find((tile) => tile.key === from);
  if (!origin) return tiles[0]?.key ?? null;
  const cx = origin.x + origin.w / 2;
  const cy = origin.y + origin.h / 2;
  let best: { key: string; score: number } | null = null;
  for (const tile of tiles) {
    if (tile.key === from) continue;
    const dx = tile.x + tile.w / 2 - cx;
    const dy = tile.y + tile.h / 2 - cy;
    const along = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0.5) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { key: tile.key, score };
  }
  return best?.key ?? null;
}

export type MarketPhase = "open" | "break" | "closed" | "pre-open" | "unknown";

const zoneDates = new Map<string, Intl.DateTimeFormat>();
function zoneDate(now: Date, timeZone: string) {
  let format = zoneDates.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }
    zoneDates.set(timeZone, format);
  }
  return format.format(now);
}

/** Where an exchange's regular session stands at `now`, from its scheduled sessions. */
export function marketPhase(
  sessions: ReadonlyArray<SectorSessionWindow>,
  timeZone: string,
  now: Date,
): { phase: MarketPhase; session: SectorSessionWindow | null; next: SectorSessionWindow | null } {
  const at = now.getTime();
  const ordered = [...sessions].sort((a, b) => Date.parse(a.open) - Date.parse(b.open));
  const next = ordered.find((session) => Date.parse(session.open) > at) ?? null;
  const current = ordered.find((session) => Date.parse(session.open) <= at && at < Date.parse(session.close));
  if (current) {
    const inBreak = current.breakStart && current.breakEnd
      && Date.parse(current.breakStart) <= at && at < Date.parse(current.breakEnd);
    return { phase: inBreak ? "break" : "open", session: current, next };
  }
  if (!ordered.length) return { phase: "unknown", session: null, next: null };
  const last = [...ordered].reverse().find((session) => Date.parse(session.close) <= at) ?? null;
  const today = zoneDate(now, timeZone);
  if (next && next.date === today) return { phase: "pre-open", session: last, next };
  return { phase: "closed", session: last, next };
}

/** Share of the session's trading time elapsed at a bar, so a partial day draws partway across. */
export function sessionPosition(session: SectorSessionWindow | null, time: string): number | null {
  if (!session) return null;
  const open = Date.parse(session.open);
  const close = Date.parse(session.close);
  const at = Date.parse(time);
  if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(at) || close <= open) return null;
  const breakStart = session.breakStart ? Date.parse(session.breakStart) : null;
  const breakEnd = session.breakEnd ? Date.parse(session.breakEnd) : null;
  const pause = breakStart != null && breakEnd != null && breakEnd > breakStart ? breakEnd - breakStart : 0;
  let elapsed = Math.min(Math.max(at - open, 0), close - open);
  if (pause && breakStart != null && breakEnd != null) {
    if (at >= breakEnd) elapsed -= pause;
    else if (at > breakStart) elapsed = breakStart - open;
  }
  return Math.min(Math.max(elapsed / (close - open - pause), 0), 1);
}

export type SparkPoint = { x: number; y: number; value: number };

/**
 * An intraday line in a w×h box. The value axis always includes zero (the
 * previous close); gaps in the data break the line rather than bridging it.
 */
export function sparkline(
  values: ReadonlyArray<number | null>,
  positions: ReadonlyArray<number | null>,
  width: number,
  height: number,
  inset = 4,
) {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  const low = Math.min(0, ...finite);
  const high = Math.max(0, ...finite);
  const span = high - low || 0.001;
  const y = (value: number) => inset + (1 - (value - low) / span) * (height - inset * 2);
  const points: Array<SparkPoint | null> = values.map((value, index) => {
    const position = positions[index];
    return value == null || !Number.isFinite(value) || position == null ? null : { x: position * width, y: y(value), value };
  });
  let path = "";
  let pen = false;
  for (const point of points) {
    if (!point) {
      pen = false;
      continue;
    }
    path += (pen ? "L" : "M") + point.x.toFixed(1) + " " + point.y.toFixed(1);
    pen = true;
  }
  const drawn = points.filter((point): point is SparkPoint => point != null);
  const peak = drawn.length ? drawn.reduce((best, point) => (point.value > best.value ? point : best)) : null;
  const last = drawn.at(-1) ?? null;
  return { path, zero: y(0), peak, last };
}

/** Colour intensity in [-1, 1] for a session change; ±3% and beyond saturate. */
export function heat(change: number | null | undefined, saturation = 0.03) {
  // Inside the ±0.05% unchanged band (inclusive, as the server counts breadth) there is no colour.
  if (change == null || !Number.isFinite(change) || Math.abs(change) <= 0.0005 + 1e-9) return 0;
  return Math.sign(change) * Math.min(1, Math.abs(change) / saturation) ** 0.7;
}

/** Today's rank; null when too little of the group is priced to rank it. */
function standing(group: Pick<SectorGroup, "ranks">) {
  return group.ranks?.at(-1) ?? null;
}

/**
 * Ranked groups first, best rank first (ties by the larger move); groups too thinly
 * priced to rank follow, by their move. A one-name sector never heads the list.
 */
export function byStanding(a: Pick<SectorGroup, "ranks" | "change">, b: Pick<SectorGroup, "ranks" | "change">) {
  const left = standing(a);
  const right = standing(b);
  if (left != null && right != null && left !== right) return left - right;
  if ((left == null) !== (right == null)) return left == null ? 1 : -1;
  return (b.change ?? -Infinity) - (a.change ?? -Infinity);
}

/** The group a board opens on: the day's best-ranked, so the detail is never empty. */
export function strongestGroup(groups: ReadonlyArray<SectorGroup>): string | null {
  return [...groups].sort(byStanding)[0]?.key ?? null;
}
