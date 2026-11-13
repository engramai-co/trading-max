import type { DashboardLens, Holding } from "@/lib/types";
import type { AttentionFact, HoldingSignal } from "./attention";
import { findETF, type ETFReading } from "./etf-data";
import { combinedHoldingPnl, finite, groupHoldings, isFundHolding } from "./holding-groups";

/**
 * Holdings always listed. Every listed row owns a palette colour: the flagged holdings beyond these take the
 * next ones, and the signal cap keeps them inside the palette.
 */
export const COLOURED_HOLDINGS = 8;

export type LedgerRow = {
  ticker: string;
  name: string;
  quotePrice: number | null;
  quoteCurrency: string;
  value: number;
  /** Share of invested value; cash is excluded. */
  weight: number;
  /** The latest session's move in the security, across accounts. */
  day: number | null;
  dayClosed: boolean;
  /** The session that move belongs to, when it is older than the table's column. */
  dayDate: string | null;
  /** Unrealized P&L against combined cost. */
  pnl: number | null;
  fund: boolean;
  etf?: ETFReading;
  score: number | null;
  upside: number | null;
  /** Index into the allocation palette for this row's own donut segment. */
  colour: number;
  facts: AttentionFact[];
  href: string;
};

export type LedgerGroup = { kind: "stocks" | "funds"; rows: LedgerRow[] };

export type HoldingsLedger = {
  /** Overall rank still determines the donut order and palette. */
  rows: LedgerRow[];
  /** The table and phone list read by class, then by weight. */
  groups: LedgerGroup[];
  /** Holdings without a row of their own: the closing row and the donut's neutral segment. */
  rest: { count: number; value: number; weight: number };
  /** The newest session among the day moves, which the column is named for. */
  columnDay: string | null;
  count: number;
  total: number;
};

/**
 * One security's move in its latest session across the accounts holding it. The API measures each
 * position on the shares held through the session, so its share is exact and the opening it implies
 * (change ÷ share) weights the accounts. Where an opening cannot be inferred, the largest position's own
 * share stands for the security rather than an estimate.
 */
function dayMove(positions: Holding[]) {
  // The overview merges by display ticker, which can include different listings.
  // A closed position cannot stand in for an open or unidentified one.
  if (positions.every((h) => h.dayChangeClosedOn)) {
    const date = positions.map((h) => h.dayChangeClosedOn!).sort().at(-1)!;
    return { share: null, date, closed: true };
  }
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
export function holdingsLedger({ holdings, technical, valuations, etfs, signals }: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  etfs?: ETFReading[];
  signals: HoldingSignal[];
}): HoldingsLedger {
  const securities = [...groupHoldings(holdings)].map(([ticker, positions]) => ({
    ticker,
    positions,
    fund: isFundHolding(positions),
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
    const { ticker, positions, value, fund } = security;
    const move = moves.get(ticker)!;
    const signal = flagged.get(ticker);
    return {
      ticker,
      name: positions[0].name,
      quotePrice: finite(positions[0].currentPrice),
      quoteCurrency: positions[0].priceCurrency,
      value,
      weight: share(value),
      day: move.share,
      dayClosed: move.closed === true,
      dayDate: move.date && move.date !== columnDay ? move.date : null,
      pnl: combinedHoldingPnl(positions),
      fund,
      etf: fund ? findETF(etfs, ticker, positions[0].fundIsin) : undefined,
      score: fund ? null : finite(technical?.find((row) => row.ticker === ticker)?.score),
      upside: fund ? null : finite(valuations?.find((row) => row.ticker === ticker)?.ev5Upside),
      colour: index,
      facts: signal?.facts ?? [],
      href: (!fund && signal?.href) || "/research?ticker=" + encodeURIComponent(positions[0].researchTicker ?? ticker),
    };
  });
  const groups: LedgerGroup[] = [
    { kind: "stocks", rows: rows.filter((row) => !row.fund) },
    { kind: "funds", rows: rows.filter((row) => row.fund) },
  ];
  // Rank by total class value, including the unlisted tail. A late signal can
  // reveal a row without swapping the groups under the reader.
  const classValue = securities.reduce((value, security) => {
    value[security.fund ? "funds" : "stocks"] += security.value;
    return value;
  }, { stocks: 0, funds: 0 });
  groups.sort((a, b) => classValue[b.kind] - classValue[a.kind]);
  const restValue = hidden.reduce((sum, security) => sum + security.value, 0);
  return {
    rows,
    groups: groups.filter((group) => group.rows.length > 0),
    rest: { count: hidden.length, value: restValue, weight: share(restValue) },
    columnDay,
    count: securities.length,
    total,
  };
}
