import { describe, expect, it } from "vitest";
import { tone } from "./data";
import { holdingQuantityUnit, holdingQuote } from "./holding-detail-data";

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
