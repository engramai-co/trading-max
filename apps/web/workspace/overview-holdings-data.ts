import type { DashboardLens, Holding } from "@/lib/types";
import type { AttentionFact, HoldingSignal } from "./attention";

/**
 * Holdings always listed. Every listed row owns a palette colour: the flagged holdings beyond these take the
 * next ones, and the signal cap keeps them inside the palette.
 */
export const COLOURED_HOLDINGS = 8;

export type LedgerRow = {
  ticker: string;
  name: string;
  value: number;
  /** Share of invested value; cash is excluded. */
  weight: number;
  /** The latest session's move in the security, across accounts. */
  day: number | null;
  /** The session that move belongs to, when it is older than the table's column. */
  dayDate: string | null;
  /** Unrealized P&L against combined cost. */
  pnl: number | null;
  /** Funds carry no company research scores yet. */
  fund: boolean;
  score: number | null;
  upside: number | null;
  /** Index into the allocation palette for this row's own donut segment. */
  colour: number;
  facts: AttentionFact[];
  href: string;
};

export type HoldingsLedger = {
  rows: LedgerRow[];
  /** Holdings without a row of their own: the closing row and the donut's neutral segment. */
  rest: { count: number; value: number; weight: number };
  /** The newest session among the day moves, which the column is named for. */
  columnDay: string | null;
  count: number;
  total: number;
};

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One security's move in its latest session across the accounts holding it. The API measures each
 * position on the shares held through the session, so its share is exact and the opening it implies
 * (change ÷ share) weights the accounts. Where an opening cannot be inferred, the largest position's own
 * share stands for the security rather than an estimate.
 */
function dayMove(positions: Holding[]) {
  const dated = positions.filter((h) => finite(h.dayChangeGbp) != null && h.dayChangeDate);
  if (!dated.length) return { share: null, date: null };
  const date = dated.map((h) => h.dayChangeDate!).sort().at(-1)!;
  const same = dated.filter((h) => h.dayChangeDate === date);
  const openings = same.map((h) => {
    const share = finite(h.dayChangePct);
    return share != null && Math.abs(share) > 1e-9 ? h.dayChangeGbp! / share : null;
  });
  if (same.length > 1 && openings.every((opening) => opening != null && opening > 0)) {
    const change = same.reduce<number>((sum, h) => sum + (h.dayChangeGbp ?? 0), 0);
    return { share: change / openings.reduce<number>((sum, opening) => sum + (opening ?? 0), 0), date };
  }
  const largest = same.reduce((a, b) => ((finite(b.currentValueGbp) ?? 0) > (finite(a.currentValueGbp) ?? 0) ? b : a));
  return { share: finite(largest.dayChangePct), date };
}

/**
 * The overview's holdings: one row per security across accounts, largest first. The largest eight are
 * always listed; a flagged holding beyond them gets its row too, every listed row owns a donut segment,
 * and everything else closes as one row and one neutral segment. Signals arrive ranked and capped.
 */
export function holdingsLedger({ holdings, technical, valuations, signals }: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  signals: HoldingSignal[];
}): HoldingsLedger {
  const byTicker = new Map<string, Holding[]>();
  for (const holding of holdings) byTicker.set(holding.ticker, [...(byTicker.get(holding.ticker) ?? []), holding]);
  const securities = [...byTicker.entries()].map(([ticker, positions]) => ({
    ticker,
    positions,
    value: positions.reduce((sum, h) => sum + (finite(h.currentValueGbp) ?? 0), 0),
  })).sort((a, b) => b.value - a.value || a.ticker.localeCompare(b.ticker));
  const total = securities.reduce((sum, security) => sum + security.value, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);
  const moves = new Map(securities.map((security) => [security.ticker, dayMove(security.positions)]));
  const columnDay = [...moves.values()].flatMap((move) => (move.date ? [move.date] : [])).sort().at(-1) ?? null;
  const flagged = new Map(signals.map((signal) => [signal.ticker, signal]));
  const shown = securities.filter((security, index) => index < COLOURED_HOLDINGS || flagged.has(security.ticker));
  const hidden = securities.filter((security, index) => index >= COLOURED_HOLDINGS && !flagged.has(security.ticker));
  const rows = shown.map((security, index): LedgerRow => {
    const { ticker, positions, value } = security;
    const cost = positions.reduce((sum, h) => sum + (finite(h.costGbp) ?? 0), 0);
    const pnl = positions.reduce((sum, h) => sum + (finite(h.pnlGbp) ?? 0), 0);
    const move = moves.get(ticker)!;
    const signal = flagged.get(ticker);
    const fund = positions.some((h) => h.isFund);
    return {
      ticker,
      name: positions[0].name,
      value,
      weight: share(value),
      day: move.share,
      dayDate: move.date && move.date !== columnDay ? move.date : null,
      pnl: cost > 0 ? pnl / cost : finite(positions[0].pnlPct),
      fund,
      score: fund ? null : finite(technical?.find((row) => row.ticker === ticker)?.score),
      upside: fund ? null : finite(valuations?.find((row) => row.ticker === ticker)?.ev5Upside),
      colour: index,
      facts: signal?.facts ?? [],
      href: signal?.href ?? "/research?ticker=" + encodeURIComponent(ticker),
    };
  });
  const restValue = hidden.reduce((sum, security) => sum + security.value, 0);
  return {
    rows,
    rest: { count: hidden.length, value: restValue, weight: share(restValue) },
    columnDay,
    count: securities.length,
    total,
  };
}
