import { describe, expect, it } from "vitest";
import { inSession, previousClose, priceBasis, quoteTime } from "./research-price-basis";

// Synthetic NYSE quote: Tuesday's close, read on Wednesday.
const close = {
  price: 214.01,
  currency: "USD",
  change: 17.76,
  changePct: 0.0905,
  asOf: "2026-11-03T21:00:03Z",
  timezone: "America/New_York",
  delayMinutes: 20,
};
const held = {
  held: true,
  brokerPrice: 194.37,
  brokerPriceCurrency: "USD",
  brokerAsOf: "2026-11-04T15:50:01Z",
};

describe("research price basis", () => {
  it("prices a held security like the holdings page and measures today from the last close", () => {
    const basis = priceBasis(held, close, null, null, new Date("2026-11-04T16:00:00Z"));
    expect(basis.source).toBe("broker");
    expect(basis.price).toBe(194.37);
    expect(basis.change).toBeCloseTo(194.37 - 214.01, 6);
    expect(basis.changePct).toBeCloseTo(194.37 / 214.01 - 1, 6);
    expect(basis.time).toEqual({
      kind: "time",
      asOf: "2026-11-04T15:50:01Z",
      stale: false,
      delayMinutes: null,
    });
  });

  it("marks a broker price late during the session and never borrows another currency's change", () => {
    const late = priceBasis(held, close, null, null, new Date("2026-11-04T17:00:00Z"));
    expect(late.time).toMatchObject({ kind: "time", stale: true });
    const pence = priceBasis(
      { ...held, brokerPriceCurrency: "GBP" },
      close,
      null,
      null,
      new Date("2026-11-04T16:00:00Z"),
    );
    expect(pence.change).toBeNull();
    expect(pence.changePct).toBeNull();
  });

  it("falls back to the research quote and names a close that a newer session has passed", () => {
    const trading = priceBasis({ held: false }, close, null, null, new Date("2026-11-04T16:00:00Z"));
    expect(trading.source).toBe("quote");
    expect(trading.change).toBe(17.76);
    expect(trading.time).toEqual({ kind: "close", date: "2026-11-03", stale: true });
    // Before Wednesday's open plus delay, Tuesday's close is still the latest price.
    expect(quoteTime(close, new Date("2026-11-04T14:50:00Z"))).toEqual({
      kind: "close",
      date: "2026-11-03",
      stale: false,
    });
    // Friday's close stays current over the weekend.
    const friday = { ...close, asOf: "2026-11-06T21:00:02Z" };
    expect(quoteTime(friday, new Date("2026-11-08T12:00:00Z"))).toMatchObject({ stale: false });
    expect(quoteTime(friday, new Date("2026-11-09T15:10:00Z"))).toMatchObject({ stale: true });
  });

  it("keeps a timely delayed quote quiet and flags a late one", () => {
    const intraday = { ...close, asOf: "2026-11-04T15:30:00Z", change: -14.01 };
    expect(quoteTime(intraday, new Date("2026-11-04T15:55:00Z"))).toEqual({
      kind: "time",
      asOf: "2026-11-04T15:30:00Z",
      stale: false,
      delayMinutes: 20,
    });
    expect(quoteTime(intraday, new Date("2026-11-04T16:30:00Z"))).toMatchObject({ stale: true });
    expect(quoteTime({ ...intraday, timezone: "Mars/Olympus" }, new Date("2026-11-05T00:00:00Z")))
      .toMatchObject({ kind: "time", stale: false });
  });

  it("reads the previous close from the quote only when the quote can tell it", () => {
    const intraday = { ...close, price: 200, change: -14.01, asOf: "2026-11-04T15:30:00Z" };
    expect(previousClose(intraday, held.brokerAsOf)).toBeCloseTo(214.01, 6);
    expect(previousClose(close, held.brokerAsOf)).toBe(214.01);
    // Yesterday's mid-session quote is not a close.
    expect(previousClose({ ...close, asOf: "2026-11-03T18:00:00Z" }, held.brokerAsOf)).toBeNull();
    expect(previousClose(close, null)).toBeNull();
  });

  it("knows regular sessions and ignores unknown or inherited zone names", () => {
    expect(inSession("America/New_York", new Date("2026-11-04T16:00:00Z"))).toBe(true);
    expect(inSession("America/New_York", new Date("2026-11-07T16:00:00Z"))).toBe(false);
    expect(inSession("constructor", new Date("2026-11-04T16:00:00Z"))).toBe(false);
  });
});
