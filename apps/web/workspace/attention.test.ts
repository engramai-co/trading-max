import { describe, expect, it } from "vitest";

import type { Holding, RefreshAttention } from "@/lib/types";
import { attentionItems, STALE_AFTER_MS } from "./attention";

const now = Date.parse("2026-10-07T12:00:00Z");
const holding = (ticker: string, costGbp: number, pnlGbp: number, account = "A") =>
  ({ ticker, account, costGbp, pnlGbp, pnlPct: pnlGbp / costGbp, currentValueGbp: costGbp + pnlGbp }) as unknown as Holding;
const technical = (ticker: string, score: number | null, rsi: number | null = 50) =>
  ({ ticker, score, rsi }) as never;
const valuation = (ticker: string, ev5Upside: number) => ({ ticker, ev5Upside }) as never;

describe("overview attention", () => {
  const refresh: RefreshAttention = {
    checkedAt: new Date(now).toISOString(),
    issues: [{ scope: "accounts", consecutiveFailures: 3, failingSince: "2026-10-06T21:00:00Z" }],
  };

  it("prioritizes repeated sync failures even when the live snapshot is fresh", () => {
    const tickers = ["A", "B", "C", "D"];
    const items = attentionItems({ holdings: tickers.map((ticker) => holding(ticker, 100, -70)),
      brokerAsOf: new Date(now).toISOString(), now, refresh });
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "refresh", scope: "accounts", minutes: 900, failures: 3 });
  });

  it("shows one update warning and removes it on confirmed recovery", () => {
    const issues: RefreshAttention["issues"] = [...refresh.issues!,
      { scope: "performance", consecutiveFailures: 4, failingSince: "2026-10-07T11:10:00Z" }];
    expect(attentionItems({ holdings: [], now, refresh: { ...refresh, issues } }))
      .toMatchObject([{ kind: "refresh", scope: "accounts" }]);
    expect(attentionItems({ holdings: [], now, refresh: { ...refresh, issues: issues.slice(1) } }))
      .toMatchObject([{ kind: "refresh", scope: "performance", minutes: 50 }]);
    expect(attentionItems({ holdings: [], now, refresh: { ...refresh, issues: [] } })).toEqual([]);
  });

  it("stays empty when nothing crosses a threshold", () => {
    expect(attentionItems({ holdings: [holding("AAA", 100, 5)], technical: [technical("AAA", 62)], brokerAsOf: "2026-10-07T11:50:00Z", now })).toEqual([]);
  });

  it("puts stale account data ahead of every security", () => {
    const items = attentionItems({
      holdings: [holding("AAA", 100, -60)],
      technical: [technical("AAA", 3, 12)],
      brokerAsOf: new Date(now - STALE_AFTER_MS - 1).toISOString(),
      now,
    });
    expect(items.map((item) => item.kind)).toEqual(["stale", "holding"]);
    expect(items[0]).toMatchObject({ hours: 6 });
  });

  it("merges readings per ticker and links to the strongest one", () => {
    const [item] = attentionItems({
      holdings: [holding("VRT", 100, -10, "A"), holding("VRT", 100, -40, "B")],
      technical: [technical("VRT", 13, 22)],
      valuations: [valuation("VRT", -0.3)],
      now,
    });
    expect(item).toMatchObject({ kind: "holding", ticker: "VRT", href: "/research?ticker=VRT&view=technical&technicalView=data" });
    if (item.kind !== "holding") throw new Error("expected a holding");
    expect(item.facts.map((fact) => fact.kind)).toEqual(["score", "upside"]);
  });

  it("measures the loss across accounts against combined cost", () => {
    const items = attentionItems({ holdings: [holding("BE", 100, -30), holding("BE", 100, 20)], now });
    expect(items).toEqual([]);
    const [deep] = attentionItems({ holdings: [holding("BE", 100, -30), holding("BE", 100, -15)], now });
    expect(deep).toMatchObject({ ticker: "BE", href: "/holdings" });
  });

  it("ranks by severity and keeps at most four", () => {
    const tickers = ["A", "B", "C", "D", "E"];
    const items = attentionItems({
      holdings: tickers.map((ticker) => holding(ticker, 100, 0)),
      technical: tickers.map((ticker, index) => technical(ticker, index * 5)),
      now,
    });
    expect(items.map((item) => (item.kind === "holding" ? item.ticker : "stale"))).toEqual(["A", "B", "C", "D"]);
  });

  it("sends a stretched valuation to the valuation lens", () => {
    const [item] = attentionItems({ holdings: [holding("ARM", 100, 0)], valuations: [valuation("ARM", -0.45)], now });
    expect(item).toMatchObject({ href: "/research?ticker=ARM&view=valuation" });
  });
});
