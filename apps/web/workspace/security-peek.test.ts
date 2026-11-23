import { describe, expect, it } from "vitest";
import { dayPeekBasis, latestSession, type PeekQuote } from "./security-peek";

describe("latestSession", () => {
  it("starts the latest session's path at the close before it", () => {
    const session = latestSession([
      { date: "2026-11-12T15:45:00-05:00", close: 99 },
      { date: "2026-11-12T16:00:00-05:00", close: 100 },
      { date: "2026-11-13T09:30:00-05:00", close: 101 },
      { date: "2026-11-13T09:45:00-05:00", close: null },
      { date: "2026-11-13T10:00:00-05:00", close: 98 },
    ]);
    expect(session.day).toBe("2026-11-13");
    expect(session.lastDate).toBe("2026-11-13T10:00:00-05:00");
    expect(session.closes).toEqual([100, 101, 98]);
    expect(session.bars).toBe(2);
    expect(session.change).toBeCloseTo(-0.02, 10);
  });

  it("keeps exchange dates, so a late US bar is not the next London day", () => {
    const session = latestSession([
      { date: "2026-11-12T15:45:00-05:00", close: 50 },
      { date: "2026-11-13T15:45:00-05:00", close: 55 },
    ]);
    expect(session.day).toBe("2026-11-13");
    expect(session.change).toBeCloseTo(0.1, 10);
  });

  it("has no move without an earlier close, and no path from one bar", () => {
    expect(latestSession([{ date: "2026-11-13T09:30:00Z", close: 10 }])).toMatchObject({ change: null, bars: 1 });
    expect(latestSession([])).toMatchObject({ day: null, lastDate: null, closes: [], change: null, bars: 0 });
  });
});

describe("dayPeekBasis", () => {
  const now = Date.UTC(2026, 10, 13, 18, 0);
  const quote: PeekQuote = {
    price: 100,
    currency: "GBP",
    move: 0.01,
    moveDay: "2026-11-13",
    closed: false,
    account: "Stocks\u00a0ISA",
    asOf: "2026-11-13T16:30:00Z",
    cited: false,
  };

  it("attributes matching broker snapshot and market path without a warning note", () => {
    expect(dayPeekBasis({
      quote,
      marketDay: "2026-11-13",
      marketBars: 6,
      lastDate: "2026-11-13T16:30:00",
      locale: "en",
      timeZone: "Europe/London",
      now,
    })).toEqual({
      mode: "broker",
      asOfText: "Today 16:30",
      brokerLabel: "Broker snapshot",
      marketPathLabel: "Market path",
      marketPathDate: "13 Nov",
      note: null,
    });
  });

  it("flags date mismatches and pinned historical citations separately from live market paths", () => {
    const stalePath = dayPeekBasis({
      quote: { ...quote, moveDay: "2026-11-12", asOf: "2026-11-12T16:30:00Z" },
      marketDay: "2026-11-13",
      marketBars: 6,
      lastDate: "2026-11-13T16:30:00",
      locale: "en",
      timeZone: "Europe/London",
      now,
    });
    expect(stalePath.note).toBe("Broker snapshot 12 Nov 16:30; the path is market data from 13 Nov");

    const cited = dayPeekBasis({
      quote: { ...quote, cited: true, asOf: null },
      marketDay: "2026-11-13",
      marketBars: 4,
      lastDate: "2026-11-13T16:30:00",
      locale: "zh",
      timeZone: "Europe/London",
      now,
    });
    expect(cited.brokerLabel).toBe("引用快照");
    expect(cited.asOfText).toBe("时间未提供");
    expect(cited.note).toBe("已引用券商快照；走势为最新行情 11月13日");
  });

  it("omits market path attribution when intraday bars are unavailable", () => {
    expect(dayPeekBasis({
      quote,
      marketDay: "2026-11-13",
      marketBars: 1,
      lastDate: "2026-11-13",
      locale: "en",
      timeZone: "Europe/London",
      now,
    })).toMatchObject({
      mode: "broker",
      marketPathLabel: null,
      marketPathDate: null,
      note: null,
    });
  });

  it("attributes aggregated exposure previews as market quotes or daily closes", () => {
    expect(dayPeekBasis({
      marketDay: "2026-11-13",
      marketBars: 6,
      lastDate: "2026-11-13T15:45:00",
      actualInterval: "15m",
      timezone: "America/New_York",
      locale: "en",
      timeZone: "Europe/London",
      now,
    })).toEqual({
      mode: "market",
      marketQuoteLabel: "Market quote",
      marketQuoteTime: "13 Nov, New York 15:45",
      note: null,
    });

    expect(dayPeekBasis({
      marketDay: "2026-11-12",
      marketBars: 1,
      lastDate: "2026-11-12",
      actualInterval: "1d",
      timezone: "Europe/London",
      locale: "zh",
      timeZone: "Europe/London",
      now,
    })).toEqual({
      mode: "market",
      marketQuoteLabel: "行情收盘",
      marketQuoteTime: "11月12日",
      note: null,
    });

    expect(dayPeekBasis({
      marketDay: null,
      marketBars: 0,
      lastDate: null,
      actualInterval: "15m",
      locale: "en",
      timeZone: "Europe/London",
      now,
    }).marketQuoteTime).toBe("Time unavailable");
  });
});
