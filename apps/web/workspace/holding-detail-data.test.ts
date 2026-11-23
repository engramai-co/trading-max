import { describe, expect, it } from "vitest";
import type { Holding } from "@/lib/types";
import { tone } from "./data";
import {
  holdingPeekQuote,
  holdingPositionAsOf,
  holdingQuantityUnit,
  holdingQuote,
} from "./holding-detail-data";

describe("change tone", () => {
  it.each([
    [0, "neutral"],
    ["0.0", "neutral"],
    [-1, "down"],
    [1, "up"],
    [null, undefined],
    [undefined, undefined],
    ["", undefined],
    [NaN, undefined],
  ])("colours %s as %s", (value, expected) => {
    expect(tone(value)).toBe(expected);
  });
});

describe("holding quote", () => {
  const cost = { dilutedCostPerShareGbp: 17.47, dilutedCostPerShareNative: 22.19 };

  it.each([
    ["GBP", 13.84, "£13.84", "£13.84", "£17.47", false, false],
    ["GBX", 1384, "GBX 1,384.00", "£13.84", "£17.47", true, false],
    ["GBp", 1384, "GBp 1,384.00", "£13.84", "£17.47", true, false],
    ["USD", 17.58, "US$17.58", "US$17.58", "US$22.19", false, true],
  ] as const)("uses the correct price and cost units for %s", (
    priceCurrency, currentPrice, raw, price, dilutedCost, pence, foreign,
  ) => {
    expect(holdingQuote({ ...cost, priceCurrency, currentPrice, dilutedCostCurrency: priceCurrency }))
      .toEqual({ raw, price, dilutedCost, pence, foreign });
  });

  it("does not substitute pounds for an unavailable foreign diluted cost", () => {
    expect(holdingQuote({
      ...cost,
      currentPrice: 17.58,
      priceCurrency: "USD",
      dilutedCostCurrency: "USD",
      dilutedCostPerShareNative: null,
    }).dilutedCost).toBe("—");
  });
});

describe("holding quantity unit", () => {
  it.each([
    [true, "zh", 10, "份"],
    [false, "zh", 10, "股"],
    [true, "en", 10, "units"],
    [false, "en", 10, "shares"],
    [true, "en", 1, "unit"],
    [false, "en", 1, "share"],
  ] as const)("uses the right unit for a fund=%s in %s at quantity %s", (isFund, locale, quantity, unit) => {
    expect(holdingQuantityUnit(isFund, locale, quantity)).toBe(unit);
  });
});

describe("holdingPositionAsOf and holdingPeekQuote", () => {
  const base = {
    ticker: "VWRP", name: "Vanguard FTSE All-World", listingMarket: "LSE",
    isFund: true, quantity: 10, currentValueGbp: 1000, costGbp: 900,
    pnlGbp: 100, pnlPct: 0.11, allocationPct: 0.2,
    dilutedCostGbp: null, dilutedCostPerShareGbp: null, dilutedCostPerShareNative: null,
    dilutedCostCurrency: "GBP", snapshotFxRateNativePerGbp: 1, fxImpactGbp: 0,
  } satisfies Partial<Holding>;

  const investRow = {
    ...base, account: "A", currentPrice: 100, priceCurrency: "GBP",
    dayChangePct: 0.012, dayChangeDate: "2026-11-12", dayChangeClosedOn: null,
  } as Holding;

  const isaRow = {
    ...base, account: "B", currentPrice: 101.5, priceCurrency: "GBP",
    dayChangePct: null, dayChangeDate: null, dayChangeClosedOn: "2026-11-11",
  } as Holding;

  it("reads each account's own positionAsOf and keeps explicit null undated", () => {
    const lens = {
      positionAsOf: { A: "2026-11-12T16:00:00Z", B: null },
      accounts: [
        { code: "A", asOf: "2026-11-12T17:00:00Z" },
        { code: "B", asOf: "2026-11-12T17:00:00Z" },
      ] as never,
    };
    expect(holdingPositionAsOf(investRow, lens)).toBe("2026-11-12T16:00:00Z");
    expect(holdingPositionAsOf(isaRow, lens)).toBeNull();
    expect(holdingPositionAsOf(isaRow, { accounts: lens.accounts })).toBe("2026-11-12T17:00:00Z");
  });

  it("reads each row's quote and timestamp from its own account and publication lens", () => {
    const latestLens = {
      positionAsOf: { A: "2026-11-13T16:00:00Z", B: "2026-11-13T16:20:00Z" },
    };
    const retainedLens = {
      positionAsOf: { A: "2026-11-11T15:00:00Z", B: "2026-11-11T16:30:00Z" },
    };
    expect(holdingPeekQuote(investRow, latestLens, "Invest", false)).toEqual({
      price: 100,
      currency: "GBP",
      move: 0.012,
      moveDay: "2026-11-12",
      closed: false,
      account: "Invest",
      asOf: "2026-11-13T16:00:00Z",
      cited: false,
    });
    expect(holdingPeekQuote(isaRow, retainedLens, "Stocks\u00a0ISA", true)).toEqual({
      price: 101.5,
      currency: "GBP",
      move: null,
      moveDay: "2026-11-11",
      closed: true,
      account: "Stocks\u00a0ISA",
      asOf: "2026-11-11T16:30:00Z",
      cited: true,
    });
  });
});
