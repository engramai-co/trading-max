import { describe, expect, it } from "vitest";

import {
  formatCalendarDate,
  formatCompactCurrency,
  formatCurrency,
  formatDateSpan,
  formatNumber,
  formatDateTime,
  formatDeltaPercent,
  formatEventTime,
  formatPercent,
  formatScheduleTimes,
} from "@/ui/formatters";

describe("shared financial formatters", () => {
  it.each([
    ["GBP currency", () => formatCurrency(Number.NaN, "en")],
    ["USD currency", () => formatCurrency(Number.POSITIVE_INFINITY, "en", "USD")],
    ["percent", () => formatPercent(Number.NaN, "en")],
    ["percent change", () => formatDeltaPercent(Number.NEGATIVE_INFINITY, "en")],
    ["formatPercent", () => formatPercent(Number.POSITIVE_INFINITY, "en")],
    ["formatDeltaPercent", () => formatDeltaPercent(Number.NaN, "zh")],
    ["number", () => formatNumber(Number.NaN, "en")],
    ["compact currency", () => formatCompactCurrency(Number.POSITIVE_INFINITY, "en")],
  ])("renders unavailable text for non-finite %s values", (_name, render) => {
    expect(render()).toBe("—");
  });

  it("keeps level percentages unsigned and direction signs exclusive to changes", () => {
    expect(formatPercent(-0.217, "en")).toBe("-21.7%");
    expect(formatDeltaPercent(-0.217, "en")).toBe("-21.7%");
    expect(formatPercent(0.217, "en")).toBe("21.7%");
    expect(formatDeltaPercent(0.217, "en")).toBe("+21.7%");
  });

  it("renders compact currency axis labels with lower-case units", () => {
    expect(formatCompactCurrency(5_000, "en", "GBP")).toBe("£5k");
    expect(formatCompactCurrency(28_000, "zh", "GBP")).toBe("£28k");
    expect(formatCompactCurrency(-5_000, "en", "GBP")).toBe("-£5k");
  });

  it("converts London automation times into the selected display timezone", () => {
    expect(formatScheduleTimes(
      ["06:30", "12:00", "17:30", "22:30"],
      "en",
      "Europe/London",
      "Asia/Hong_Kong",
      "2026-08-28T00:00:00Z",
    )).toEqual(["13:30", "19:00", "00:30", "05:30"]);
  });

  it("accounts for London daylight-saving changes", () => {
    expect(formatScheduleTimes(
      ["06:30"],
      "en",
      "Europe/London",
      "Asia/Hong_Kong",
      "2026-12-01T00:00:00Z",
    )).toEqual(["14:30"]);
  });

  it("formats timestamps in the selected display timezone", () => {
    const formatted = formatDateTime(
      "2026-08-28T02:40:00Z",
      "en",
      "Asia/Hong_Kong",
      Date.parse("2026-10-28T12:00:00Z"),
    );
    expect(formatted).toBe("28 Aug 10:40");
  });

  it("names today and earlier years without repeating the reader's own time zone", () => {
    const now = Date.parse("2026-10-28T23:30:00Z");
    expect(formatDateTime("2026-10-28T22:00:00Z", "zh", "Europe/London", now)).toBe("今日 22:00");
    // It is already the next morning in Hong Kong, so 20:00 there is not "today".
    expect(formatDateTime("2026-10-28T12:00:00Z", "zh", "Asia/Hong_Kong", now)).toBe("10月28日 20:00");
    expect(formatDateTime("2025-03-04T09:05:00Z", "en", "Europe/London", now)).toBe("4 Mar 2025 09:05");
  });

  it("formats calendar dates and spans without raw ISO strings", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(formatCalendarDate("2026-10-30", "zh", now)).toBe("10月30日");
    expect(formatCalendarDate("2028-01-31", "zh", now)).toBe("2028年1月31日");
    expect(formatDateSpan("2026-08-03", "2026-10-30", "zh", now)).toBe("8月3日 – 10月30日");
    expect(formatDateSpan("2025-08-29", "2026-11-01", "zh", now)).toBe("2025年8月29日 – 11月1日");
  });

  it("shows an earnings time on the reader's clock without a GMT offset", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    // After the US close in summer: 16:05 New York (GMT-4) is 21:05 in London (BST).
    expect(formatEventTime("2026-07-28T16:05:00-04:00", "2026-07-28", "en", "Europe/London", now)).toBe("21:05");
    // The week the UK has left summer time and the US has not: 16:20 GMT-4 is 20:20 GMT.
    expect(formatEventTime("2026-10-29T16:20:00-04:00", "2026-10-29", "zh", "Europe/London", now)).toBe("20:20");
    // In winter New York is GMT-5.
    expect(formatEventTime("2026-02-10T16:05:00-05:00", "2026-02-10", "en", "Europe/London", now)).toBe("21:05");
    for (const locale of ["zh", "en"] as const) {
      expect(formatEventTime("2026-02-10T16:05:00-05:00", "2026-02-10", locale, "Europe/London", now)).not.toMatch(/GMT|UTC|[+-]\d/);
    }
  });

  it("adds the day when the reader's clock has turned to another one", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    // 16:20 New York on 29 Oct is already 30 Oct in Shanghai.
    expect(formatEventTime("2026-10-29T16:20:00-04:00", "2026-10-29", "zh", "Asia/Shanghai", now)).toBe("10月30日 04:20");
    expect(formatEventTime("2026-10-29T16:20:00-04:00", "2026-10-29", "en", "Asia/Shanghai", now)).toBe("30 Oct, 04:20");
    // Before the Tokyo open, London is still on the previous evening.
    expect(formatEventTime("2026-11-13T07:00:00+09:00", "2026-11-13", "en", "Europe/London", now)).toBe("12 Nov, 22:00");
    // An invalid zone falls back to London, never to the exchange's clock.
    expect(formatEventTime("2026-07-28T16:05:00-04:00", "2026-07-28", "en", "Not/AZone", now)).toBe("21:05");
  });
});
