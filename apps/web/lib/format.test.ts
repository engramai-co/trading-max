import { describe, expect, it } from "vitest";

import { compact, deltaPct, gbp, money, pct, ratio } from "@/lib/format";
import {
  formatCompactCurrency,
  formatDateTime,
  formatDeltaPercent,
  formatPercent,
  formatScheduleTimes,
} from "@/ui/formatters";

describe("shared financial formatters", () => {
  it.each([
    ["gbp", () => gbp(Number.NaN)],
    ["money", () => money(Number.POSITIVE_INFINITY)],
    ["pct", () => pct(Number.NaN)],
    ["deltaPct", () => deltaPct(Number.NEGATIVE_INFINITY)],
    ["formatPercent", () => formatPercent(Number.POSITIVE_INFINITY, "en")],
    ["formatDeltaPercent", () => formatDeltaPercent(Number.NaN, "zh")],
    ["ratio", () => ratio(Number.NaN)],
    ["compact", () => compact(Number.POSITIVE_INFINITY)],
  ])("renders unavailable text for non-finite %s values", (_name, render) => {
    expect(render()).toBe("—");
  });

  it("keeps level percentages unsigned and direction signs exclusive to changes", () => {
    expect(pct(0.217)).toBe("21.7%");
    expect(pct(-0.217)).toBe("-21.7%");
    expect(deltaPct(0.217)).toBe("+21.7%");
    expect(deltaPct(-0.217)).toBe("-21.7%");
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
    );
    expect(formatted).toContain("10:40");
    expect(formatted).toMatch(/GMT\+8|HKT/);
  });
});
