import type { DashboardLens, Holding } from "@/lib/types";

/** One reading that crossed an attention threshold for a held security. */
export type AttentionFact = { kind: "score" | "rsi" | "upside" | "loss"; value: number; severity: number };

export type AttentionItem =
  | { kind: "stale"; hours: number; severity: number }
  | { kind: "holding"; ticker: string; facts: AttentionFact[]; href: string; severity: number };

export const ATTENTION_LIMIT = 4;
/** Broker data normally refreshes every few minutes; six hours means updates stopped. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function factsFor(
  ticker: string,
  positions: Holding[],
  technical: DashboardLens["technical"],
  valuations: DashboardLens["valuations"],
): AttentionFact[] {
  const facts: AttentionFact[] = [];
  const signal = technical?.find((row) => row.ticker === ticker);
  const score = finite(signal?.score);
  if (score != null && score <= 30) facts.push({ kind: "score", value: score, severity: 60 + (30 - score) });
  const rsi = finite(signal?.rsi);
  if (rsi != null && (rsi >= 75 || rsi <= 25)) facts.push({ kind: "rsi", value: Math.round(rsi), severity: 40 + Math.abs(rsi - 50) - 25 });
  const upside = finite(valuations?.find((row) => row.ticker === ticker)?.ev5Upside);
  if (upside != null && upside <= -0.2) facts.push({ kind: "upside", value: upside, severity: 55 + Math.min(30, (-upside - 0.2) * 100) });
  const cost = positions.reduce((sum, h) => sum + (finite(h.costGbp) ?? 0), 0);
  const pnl = positions.reduce((sum, h) => sum + (finite(h.pnlGbp) ?? 0), 0);
  const loss = cost > 0 ? pnl / cost : finite(positions[0]?.pnlPct);
  if (loss != null && loss <= -0.2) facts.push({ kind: "loss", value: loss, severity: 45 + Math.min(30, (-loss - 0.2) * 100) });
  return facts.sort((a, b) => b.severity - a.severity);
}

function hrefFor(ticker: string, lead: AttentionFact) {
  if (lead.kind === "loss") return "/holdings";
  const base = "/research?ticker=" + encodeURIComponent(ticker);
  return lead.kind === "upside" ? base + "&view=valuation" : base + "&view=technical&technicalView=data";
}

/**
 * Rank what deserves a look today from data the overview already holds:
 * stale account data first, then held securities with weak technicals,
 * stretched RSI, negative model upside or a deep loss against cost.
 */
export function attentionItems({
  holdings,
  technical,
  valuations,
  brokerAsOf,
  now,
}: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  brokerAsOf?: string | null;
  now: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const asOf = brokerAsOf ? Date.parse(brokerAsOf) : NaN;
  if (brokerAsOf && Number.isFinite(asOf) && now - asOf > STALE_AFTER_MS)
    items.push({ kind: "stale", hours: Math.floor((now - asOf) / 3_600_000), severity: Number.POSITIVE_INFINITY });
  const byTicker = new Map<string, Holding[]>();
  for (const holding of holdings) byTicker.set(holding.ticker, [...(byTicker.get(holding.ticker) ?? []), holding]);
  for (const [ticker, positions] of byTicker) {
    const facts = factsFor(ticker, positions, technical, valuations);
    if (!facts.length) continue;
    items.push({
      kind: "holding",
      ticker,
      facts: facts.slice(0, 2),
      href: hrefFor(ticker, facts[0]),
      severity: facts[0].severity + 5 * (facts.length - 1),
    });
  }
  return items.sort((a, b) => b.severity - a.severity).slice(0, ATTENTION_LIMIT);
}
