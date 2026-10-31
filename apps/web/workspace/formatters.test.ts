import { describe, expect, it } from "vitest";

import {
  formatCompactCurrency,
  formatCurrency,
  formatNumber,
  formatDateTime,
  formatDeltaPercent,
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
    expect(formatDateTime("2026-10-28T22:00:00Z", "zh", "Europe/London", now)).toBe("今天 22:00");
    // It is already the next morning in Hong Kong, so 20:00 there is not "today".
    expect(formatDateTime("2026-10-28T12:00:00Z", "zh", "Asia/Hong_Kong", now)).toBe("10月28日 20:00");
    expect(formatDateTime("2025-03-04T09:05:00Z", "en", "Europe/London", now)).toBe("4 Mar 2025 09:05");
  });
});
