import { describe, expect, it } from "vitest";

import type { Holding, RefreshAttention } from "@/lib/types";
import { attentionItems, holdingSignals, STALE_AFTER_MS } from "./attention";

const now = Date.parse("2026-10-07T12:00:00Z");
const holding = (ticker: string, costGbp: number, pnlGbp: number, account = "A", isFund = false) =>
  ({ ticker, account, costGbp, pnlGbp, pnlPct: pnlGbp / costGbp, currentValueGbp: costGbp + pnlGbp, isFund }) as unknown as Holding;
const technical = (ticker: string, score: number | null, rsi: number | null = 50) =>
  ({ ticker, score, rsi }) as never;
const valuation = (ticker: string, ev5Upside: number) => ({ ticker, ev5Upside }) as never;

describe("overview attention", () => {
  const refresh: RefreshAttention = {
    checkedAt: new Date(now).toISOString(),
    issues: [{ scope: "accounts", consecutiveFailures: 3, failingSince: "2026-10-06T21:00:00Z" }],
  };

  it("reports repeated sync failures even when the live snapshot is fresh, apart from holding signals", () => {
    const tickers = ["A", "B", "C", "D"];
    const items = attentionItems({ brokerAsOf: new Date(now).toISOString(), now, refresh });
    expect(items).toEqual([{ kind: "refresh", scope: "accounts", minutes: 900, failures: 3 }]);
    // A data problem no longer takes a holding's place.
    expect(holdingSignals({ holdings: tickers.map((ticker) => holding(ticker, 100, -70)) })).toHaveLength(4);
  });

  it("shows one update warning and removes it on confirmed recovery", () => {
    const issues: RefreshAttention["issues"] = [...refresh.issues!,
      { scope: "performance", consecutiveFailures: 4, failingSince: "2026-10-07T11:10:00Z" }];
    expect(attentionItems({ now, refresh: { ...refresh, issues } }))
      .toMatchObject([{ kind: "refresh", scope: "accounts" }]);
    expect(attentionItems({ now, refresh: { ...refresh, issues: issues.slice(1) } }))
      .toMatchObject([{ kind: "refresh", scope: "performance", minutes: 50 }]);
    expect(attentionItems({ now, refresh: { ...refresh, issues: [] } })).toEqual([]);
  });

  it("stays empty when nothing crosses a threshold", () => {
    expect(attentionItems({ brokerAsOf: "2026-10-07T11:50:00Z", now })).toEqual([]);
    expect(holdingSignals({ holdings: [holding("AAA", 100, 5)], technical: [technical("AAA", 62)] })).toEqual([]);
  });

  it("reports stale account data on its own", () => {
    const items = attentionItems({ brokerAsOf: new Date(now - STALE_AFTER_MS - 1).toISOString(), now });
    expect(items).toEqual([{ kind: "stale", hours: 6 }]);
  });

  it("merges readings per ticker and links to the strongest one", () => {
    const [item] = holdingSignals({
      holdings: [holding("VRT", 100, -10, "A"), holding("VRT", 100, -40, "B")],
      technical: [technical("VRT", 13, 22)],
      valuations: [valuation("VRT", -0.3)],
    });
    expect(item).toMatchObject({ ticker: "VRT", href: "/research?ticker=VRT&view=technical&technicalView=data" });
    expect(item.facts.map((fact) => fact.kind)).toEqual(["score", "upside", "loss", "rsi"]);
  });

  it("flags technical readings for a fund by listing ticker and ignores stock valuation", () => {
    const fund = { ...holding("IGLT", 100, 0, "B", true), researchTicker: "IGLT.L" };
    const [signal] = holdingSignals({
      holdings: [fund],
      technical: [technical("IGLT", 50), technical("IGLT.L", 0, 12)],
      valuations: [valuation("IGLT", -0.5)],
    });
    expect(signal).toMatchObject({ ticker: "IGLT", href: "/research?ticker=IGLT.L&view=technical&technicalView=data" });
    expect(signal.facts.map((fact) => fact.kind)).toEqual(["score", "rsi"]);
    expect(holdingSignals({ holdings: [fund], technical: [technical("IGLT", 12)] })[0].facts[0].value).toBe(12);
  });

  it("measures the loss across accounts against combined cost", () => {
    expect(holdingSignals({ holdings: [holding("BE", 100, -30), holding("BE", 100, 20)] })).toEqual([]);
    const [deep] = holdingSignals({ holdings: [holding("BE", 100, -30), holding("BE", 100, -15)] });
    expect(deep).toMatchObject({ ticker: "BE", href: "/holdings" });
  });

  it("ranks by severity and keeps at most four", () => {
    const tickers = ["A", "B", "C", "D", "E"];
    const items = holdingSignals({
      holdings: tickers.map((ticker) => holding(ticker, 100, 0)),
      technical: tickers.map((ticker, index) => technical(ticker, index * 5)),
    });
    expect(items.map((item) => item.ticker)).toEqual(["A", "B", "C", "D"]);
  });

  it("sends a stretched valuation to the valuation lens", () => {
    const [item] = holdingSignals({ holdings: [holding("ARM", 100, 0)], valuations: [valuation("ARM", -0.45)] });
    expect(item).toMatchObject({ href: "/research?ticker=ARM&view=valuation" });
  });
});

it("ETF tracking dots require comparable fresh tracking; overlap never flags a row", () => {
  const fund = { ...holding("EQQQ", 100, -20), isFund: true };
  const reading = {
    isin: "IE0032077012", tickers: ["EQQQ"], holdingsState: "available" as const,
    tracking: { state: "available" as const, differencePp: -0.50 },
    overlap: { state: "available" as const, value: 0.50, datesValid: true, fundCoverage: 0.90, restCoverage: 0.90 },
  };
  const [signal] = holdingSignals({ holdings: [fund], etfs: [reading] });
  expect(signal.facts.map((fact) => fact.kind)).toEqual(["tracking", "loss"]);
  const [lossOnly] = holdingSignals({
    holdings: [fund],
    etfs: [{ ...reading, tracking: { ...reading.tracking, state: "stale" } }],
  });
  expect(lossOnly.facts.map((fact) => fact.kind)).toEqual(["loss"]);
  const limited = holdingSignals({ holdings: [fund], etfs: [reading], limit: 1 });
  expect(limited[0].facts.map((fact) => fact.kind)).toEqual(["tracking", "loss"]);
  const mixed = holdingSignals({
    holdings: [fund, holding("STRONG", 100, 0), holding("UPSIDE", 100, 0), holding("LOSS", 100, -30), holding("SMALL", 100, 0, "A", true)],
    technical: [technical("STRONG", 0)],
    valuations: [valuation("UPSIDE", -0.24)],
    etfs: [reading, { ...reading, isin: "IE00BYVTMW98", tickers: ["SMALL"], tracking: { ...reading.tracking, state: "stale" } }],
  });
  expect(mixed.map((signal) => signal.ticker)).toEqual(["STRONG", "EQQQ", "UPSIDE", "LOSS"]);
  expect(mixed[1].facts.map((fact) => fact.kind)).toEqual(["tracking", "loss"]);
});
