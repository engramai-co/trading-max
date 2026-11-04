import { describe, expect, it } from "vitest";
import {
  basisPrice,
  brokerPriceLate,
  inSession,
  previousClose,
  priceBasis,
  quoteTime,
} from "./research-price-basis";

// Synthetic NYSE quote: Tuesday's close, read on Wednesday.
const close = {
  price: 214.01,
  currency: "USD",
  change: 17.76,
  changePct: 0.0905,
  asOf: "2026-11-03T21:00:03Z",
  timezone: "America/New_York",
  delayMinutes: 20,
  listing: "US:SYNT",
};
const held = {
  held: true,
  brokerPrice: 194.37,
  brokerPriceCurrency: "USD",
  brokerAsOf: "2026-11-04T15:50:01Z",
  brokerListing: "US:SYNT",
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

  it("marks a broker price late during the session", () => {
    const late = priceBasis(held, close, null, null, new Date("2026-11-04T17:00:00Z"));
    expect(late.time).toMatchObject({ kind: "time", stale: true });
  });

  it("uses the broker price only for the research quote's listing", () => {
    expect(basisPrice(held, close)).toMatchObject({ source: "broker", price: 194.37, currency: "USD" });
    // A London line in dollars, or a .L alias the API collapses: same currency, another listing.
    const london = { ...held, brokerPrice: 191.2, brokerListing: "LSE:SYNT" };
    expect(basisPrice(london, close)).toEqual({
      source: "quote",
      price: 214.01,
      currency: "USD",
      asOf: close.asOf,
    });
    const header = priceBasis(london, close, null, null, new Date("2026-11-04T16:00:00Z"));
    expect(header).toMatchObject({ source: "quote", price: 214.01, change: 17.76 });
    // Several lines under one ticker name neither a listing nor a price.
    const several = {
      held: true,
      brokerPrice: null,
      brokerPriceCurrency: null,
      brokerAsOf: null,
      brokerListing: null,
    };
    expect(basisPrice(several, close)).toMatchObject({ source: "quote", price: 214.01 });
    // A line or quote whose market is unknown cannot confirm the listing.
    expect(basisPrice({ ...held, brokerListing: null }, close)).toMatchObject({ source: "quote" });
    expect(basisPrice(held, { ...close, listing: null })).toMatchObject({ source: "quote" });
    expect(basisPrice(held, undefined, 210, "USD")).toMatchObject({ source: "quote", price: 210 });
  });

  it("keeps the research basis when the broker line trades in another currency", () => {
    const other = { ...held, brokerPrice: 152.4, brokerPriceCurrency: "GBP" };
    expect(basisPrice(other, close)).toEqual({
      source: "quote",
      price: 214.01,
      currency: "USD",
      asOf: close.asOf,
    });
  });

  it("quotes a London line in pounds, like the research quote", () => {
    // The API reports a 9,500p broker price as £95.00 on the LSE listing.
    const quote = { ...close, price: 96.1, currency: "GBP", timezone: "Europe/London", listing: "LSE:SYNT" };
    const line = {
      held: true,
      brokerPrice: 95,
      brokerPriceCurrency: "GBP",
      brokerAsOf: "2026-09-01T10:20:00Z",
      brokerListing: "LSE:SYNT",
    };
    expect(basisPrice(line, quote)).toEqual({
      source: "broker",
      price: 95,
      currency: "GBP",
      asOf: line.brokerAsOf,
    });
    // Pence never stand in for pounds.
    expect(basisPrice({ ...line, brokerPrice: 9500, brokerPriceCurrency: "GBX" }, quote))
      .toMatchObject({ source: "quote", price: 96.1 });
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

  it("measures the daily change only from the immediately preceding session", () => {
    const friday = "2026-11-06T16:00:00Z";
    // Tuesday's close against Friday's broker price spans three sessions.
    expect(previousClose(close, friday)).toBeNull();
    expect(priceBasis({ ...held, brokerAsOf: friday }, close, null, null, new Date(friday)).change)
      .toBeNull();
    // Thursday's close is Friday's reference; Friday's close is Monday's.
    expect(previousClose({ ...close, asOf: "2026-11-05T21:00:02Z" }, friday)).toBe(214.01);
    expect(previousClose({ ...close, asOf: "2026-11-06T21:00:02Z" }, "2026-11-09T15:00:00Z"))
      .toBe(214.01);
  });

  it("calls a broker price late when it misses the latest session, in or out of hours", () => {
    const zone = "America/New_York";
    const wednesdayPreMarket = new Date("2026-11-04T11:00:00Z");
    // Observed at 15:00 on Tuesday: misses Tuesday's close.
    expect(brokerPriceLate(zone, new Date("2026-11-03T20:00:00Z"), wednesdayPreMarket)).toBe(true);
    // The last in-session refresh shortly before the close, or one after it, covers the session.
    expect(brokerPriceLate(zone, new Date("2026-11-03T20:45:00Z"), wednesdayPreMarket)).toBe(false);
    expect(brokerPriceLate(zone, new Date("2026-11-03T21:05:00Z"), wednesdayPreMarket)).toBe(false);
    // Friday after the close stays current over the weekend; Friday midday does not.
    const sunday = new Date("2026-11-08T12:00:00Z");
    expect(brokerPriceLate(zone, new Date("2026-11-06T21:05:00Z"), sunday)).toBe(false);
    expect(brokerPriceLate(zone, new Date("2026-11-06T17:00:00Z"), sunday)).toBe(true);
    // Unknown exchanges make no claim.
    expect(brokerPriceLate("Mars/Olympus", new Date("2026-11-01T00:00:00Z"), sunday)).toBe(false);
    const header = priceBasis(
      { ...held, brokerAsOf: "2026-11-03T20:00:00Z" },
      close,
      null,
      null,
      wednesdayPreMarket,
    );
    expect(header.time).toMatchObject({ kind: "time", stale: true });
  });

  it("knows regular sessions and ignores unknown or inherited zone names", () => {
    expect(inSession("America/New_York", new Date("2026-11-04T16:00:00Z"))).toBe(true);
    expect(inSession("America/New_York", new Date("2026-11-07T16:00:00Z"))).toBe(false);
    expect(inSession("constructor", new Date("2026-11-04T16:00:00Z"))).toBe(false);
  });
});
