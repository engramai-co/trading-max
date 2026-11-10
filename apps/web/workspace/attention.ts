import type { DashboardLens, Holding, RefreshAttention } from "@/lib/types";

/** One reading that crossed an attention threshold for a held security. */
export type AttentionFact = { kind: "score" | "rsi" | "upside" | "loss"; value: number; severity: number };

/** Account data that stopped arriving: the overview says so before any figure. */
export type AttentionItem =
  | { kind: "refresh"; scope: "accounts" | "performance"; minutes: number; failures: number }
  | { kind: "stale"; hours: number };

/** A held security whose readings crossed a threshold; the holdings table marks the affected cells. */
export type HoldingSignal = { ticker: string; facts: AttentionFact[]; href: string; severity: number };

/** At most this many holdings carry signals, so a flag still means something. */
export const SIGNAL_LIMIT = 4;
/** Where a reading starts to deserve a flag, inclusive. Score and RSI are points; upside and loss are shares. */
export const THRESHOLD = { score: 30, rsiHigh: 75, rsiLow: 25, upside: -0.2, loss: -0.2 } as const;
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
  // Funds carry no company research readings yet; only their loss against cost counts.
  if (!positions.some((h) => h.isFund)) {
    const signal = technical?.find((row) => row.ticker === ticker);
    const score = finite(signal?.score);
    if (score != null && score <= THRESHOLD.score) facts.push({ kind: "score", value: score, severity: 60 + (THRESHOLD.score - score) });
    const rsi = finite(signal?.rsi);
    if (rsi != null && (rsi >= THRESHOLD.rsiHigh || rsi <= THRESHOLD.rsiLow)) {
      facts.push({ kind: "rsi", value: Math.round(rsi), severity: 40 + Math.abs(rsi - 50) - 25 });
    }
    const upside = finite(valuations?.find((row) => row.ticker === ticker)?.ev5Upside);
    if (upside != null && upside <= THRESHOLD.upside) {
      facts.push({ kind: "upside", value: upside, severity: 55 + Math.min(30, (THRESHOLD.upside - upside) * 100) });
    }
  }
  const cost = positions.reduce((sum, h) => sum + (finite(h.costGbp) ?? 0), 0);
  const pnl = positions.reduce((sum, h) => sum + (finite(h.pnlGbp) ?? 0), 0);
  const loss = cost > 0 ? pnl / cost : finite(positions[0]?.pnlPct);
  if (loss != null && loss <= THRESHOLD.loss) facts.push({ kind: "loss", value: loss, severity: 45 + Math.min(30, (THRESHOLD.loss - loss) * 100) });
  return facts.sort((a, b) => b.severity - a.severity);
}

function hrefFor(ticker: string, lead: AttentionFact) {
  if (lead.kind === "loss") return "/holdings";
  const base = "/research?ticker=" + encodeURIComponent(ticker);
  return lead.kind === "upside" ? base + "&view=valuation" : base + "&view=technical&technicalView=data";
}

/**
 * Data problems that deserve a look before any figure: repeated update
 * failures, then account data that stopped arriving.
 */
export function attentionItems({
  brokerAsOf,
  refresh,
  now,
}: {
  brokerAsOf?: string | null;
  refresh?: RefreshAttention;
  now: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  // One actionable link for a full-sync outage, even if it also broke the
  // downstream performance job. A performance success cannot hide that outage.
  const issue = refresh?.issues?.find((item) => item.scope === "accounts") ?? refresh?.issues?.[0];
  if (issue) {
    const elapsed = Date.parse(refresh!.checkedAt) - Date.parse(issue.failingSince);
    items.push({ kind: "refresh", scope: issue.scope, failures: issue.consecutiveFailures,
      minutes: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 60_000)) : 0 });
  }
  const asOf = brokerAsOf ? Date.parse(brokerAsOf) : NaN;
  if (brokerAsOf && Number.isFinite(asOf) && now - asOf > STALE_AFTER_MS)
    items.push({ kind: "stale", hours: Math.floor((now - asOf) / 3_600_000) });
  return items;
}

/**
 * Held securities that deserve a look, worst first: weak technicals, stretched
 * RSI, negative model upside or a deep loss against cost. Readings merge per
 * ticker across accounts and all of them are kept; each link opens the lens of
 * the strongest reading. At most four holdings are flagged.
 */
export function holdingSignals({
  holdings,
  technical,
  valuations,
  limit = SIGNAL_LIMIT,
}: {
  holdings: Holding[];
  technical?: DashboardLens["technical"];
  valuations?: DashboardLens["valuations"];
  limit?: number;
}): HoldingSignal[] {
  const signals: HoldingSignal[] = [];
  const byTicker = new Map<string, Holding[]>();
  for (const holding of holdings) byTicker.set(holding.ticker, [...(byTicker.get(holding.ticker) ?? []), holding]);
  for (const [ticker, positions] of byTicker) {
    const facts = factsFor(ticker, positions, technical, valuations);
    if (!facts.length) continue;
    signals.push({
      ticker,
      facts,
      href: hrefFor(ticker, facts[0]),
      severity: facts[0].severity + 5 * (facts.length - 1),
    });
  }
  return signals.sort((a, b) => b.severity - a.severity).slice(0, limit);
}
