import { describe, expect, it } from "vitest";
import {
  basisPrice,
  brokerPriceLate,
  inSession,
  previousClose,
  priceBasis,
  quoteTime,
} from "./research-price-basis";

/** Weekday sessions as the API schedules them, without the given holidays. */
function weekdays(
  from: string,
  to: string,
  [open, close]: [string, string],
  holidays: string[] = [],
  earlyCloses: Record<string, string> = {},
) {
  const sessions = [];
  const end = new Date(to + "T00:00:00Z");
  for (const day = new Date(from + "T00:00:00Z"); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (day.getUTCDay() % 6 === 0 || holidays.includes(date)) continue;
    sessions.push({ date, open: `${date}T${open}Z`, close: `${date}T${earlyCloses[date] ?? close}Z` });
  }
  return sessions;
}

// Synthetic NYSE schedule (EST): Thanksgiving closed, the day after closes at 13:00.
const nyse = {
  calendar: "XNYS",
  sessions: weekdays("2026-11-02", "2026-12-04", ["14:30:00", "21:00:00"], ["2026-11-26"], {
    "2026-11-27": "18:00:00",
  }),
};
// Synthetic LSE schedule (BST): the summer bank holiday closed.
const lse = {
  calendar: "XLON",
  sessions: weekdays("2026-08-17", "2026-09-11", ["07:00:00", "15:30:00"], ["2026-08-31"]),
};

// Synthetic NYSE quote: Tuesday's close, read on Wednesday.
const close = {
  price: 214.01,
  currency: "USD",
  change: 17.76,
  changePct: 0.0905,
  asOf: "2026-11-03T21:00:03Z",
  delayMinutes: 20,
  listing: "US:SYNT",
  schedule: nyse,
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
    const quote = { ...close, price: 96.1, currency: "GBP", listing: "LSE:SYNT", schedule: lse };
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
    const wednesdayPreMarket = new Date("2026-11-04T11:00:00Z");
    // Observed at 15:00 on Tuesday: misses Tuesday's close.
    expect(brokerPriceLate(close, new Date("2026-11-03T20:00:00Z"), wednesdayPreMarket)).toBe(true);
    // The last in-session refresh shortly before the close, or one after it, covers the session.
    expect(brokerPriceLate(close, new Date("2026-11-03T20:45:00Z"), wednesdayPreMarket)).toBe(false);
    expect(brokerPriceLate(close, new Date("2026-11-03T21:05:00Z"), wednesdayPreMarket)).toBe(false);
    // Friday after the close stays current over the weekend; Friday midday does not.
    const sunday = new Date("2026-11-08T12:00:00Z");
    expect(brokerPriceLate(close, new Date("2026-11-06T21:05:00Z"), sunday)).toBe(false);
    expect(brokerPriceLate(close, new Date("2026-11-06T17:00:00Z"), sunday)).toBe(true);
    const header = priceBasis(
      { ...held, brokerAsOf: "2026-11-03T20:00:00Z" },
      close,
      null,
      null,
      wednesdayPreMarket,
    );
    expect(header.time).toMatchObject({ kind: "time", stale: true });
  });

  it("follows US Thanksgiving and its early close", () => {
    // Wednesday's close stays current through Thanksgiving, until Friday has traded past the delay.
    const wednesday = { ...close, asOf: "2026-11-25T21:00:02Z" };
    expect(quoteTime(wednesday, new Date("2026-11-26T16:00:00Z"))).toEqual({
      kind: "close",
      date: "2026-11-25",
      stale: false,
    });
    expect(quoteTime(wednesday, new Date("2026-11-27T15:10:00Z"))).toMatchObject({ stale: true });
    expect(inSession(close, new Date("2026-11-26T16:00:00Z"))).toBe(false);
    // Friday closes at 13:00 in New York: a quote from then is its close.
    const friday = { ...close, asOf: "2026-11-27T18:00:02Z" };
    expect(quoteTime(friday, new Date("2026-11-27T20:00:00Z"))).toEqual({
      kind: "close",
      date: "2026-11-27",
      stale: false,
    });
    // After the early close, a broker price from shortly before it covers the session.
    const afterClose = new Date("2026-11-27T20:00:00Z");
    expect(inSession(close, afterClose)).toBe(false);
    expect(brokerPriceLate(close, new Date("2026-11-27T17:50:00Z"), afterClose)).toBe(false);
    expect(brokerPriceLate(close, new Date("2026-11-27T17:00:00Z"), afterClose)).toBe(true);
    // On Thanksgiving, Wednesday's close is the latest one a broker price must cover.
    const thanksgiving = new Date("2026-11-26T16:00:00Z");
    expect(brokerPriceLate(close, new Date("2026-11-25T21:05:00Z"), thanksgiving)).toBe(false);
    // Friday's change is measured from Wednesday's close, across the holiday.
    const brokerAsOf = "2026-11-27T16:00:00Z";
    expect(previousClose(wednesday, brokerAsOf)).toBe(214.01);
    const basis = priceBasis(
      { ...held, brokerAsOf },
      wednesday,
      null,
      null,
      new Date("2026-11-27T16:05:00Z"),
    );
    expect(basis.change).toBeCloseTo(194.37 - 214.01, 6);
    expect(basis.time).toMatchObject({ stale: false });
  });

  it("follows a UK bank holiday", () => {
    // Friday's LSE close, before the summer bank holiday on Monday 31 August.
    const friday = {
      price: 95.7,
      currency: "GBP",
      change: 0.6,
      changePct: 0.0063,
      asOf: "2026-08-28T15:35:12Z",
      delayMinutes: 15,
      listing: "LSE:SYNT",
      schedule: lse,
    };
    const holiday = new Date("2026-08-31T11:00:00Z");
    expect(quoteTime(friday, holiday)).toEqual({ kind: "close", date: "2026-08-28", stale: false });
    expect(quoteTime(friday, new Date("2026-09-01T07:31:00Z"))).toMatchObject({ stale: true });
    expect(inSession(friday, holiday)).toBe(false);
    expect(brokerPriceLate(friday, new Date("2026-08-28T15:40:00Z"), holiday)).toBe(false);
    // Tuesday's change is measured from Friday's close.
    const line = {
      held: true,
      brokerPrice: 96.5,
      brokerPriceCurrency: "GBP",
      brokerAsOf: "2026-09-01T09:00:00Z",
      brokerListing: "LSE:SYNT",
    };
    const basis = priceBasis(line, friday, null, null, new Date("2026-09-01T09:05:00Z"));
    expect(basis).toMatchObject({ source: "broker", price: 96.5, time: { stale: false } });
    expect(basis.change).toBeCloseTo(96.5 - 95.7, 6);
  });

  it("makes no session claim for an unknown exchange", () => {
    const unknown = { ...close, listing: null, schedule: null };
    const wednesday = new Date("2026-11-04T16:00:00Z");
    expect(quoteTime(unknown, wednesday)).toEqual({
      kind: "time",
      asOf: close.asOf,
      stale: false,
      delayMinutes: 20,
    });
    expect(inSession(unknown, wednesday)).toBe(false);
    expect(previousClose(unknown, held.brokerAsOf)).toBeNull();
    expect(brokerPriceLate(unknown, new Date("2026-11-01T00:00:00Z"), wednesday)).toBe(false);
    expect(inSession(close, wednesday)).toBe(true);
    // Nor once the clock has run past the sessions the quote came with.
    expect(quoteTime(close, new Date("2026-12-07T16:00:00Z"))).toMatchObject({
      kind: "time",
      stale: false,
    });
  });
});
