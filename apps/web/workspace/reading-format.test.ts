import { describe, expect, it } from "vitest";
import { formatExchangeTime, formatReadingTime } from "@/ui/formatters";
import {
  comparisonFigures, fixed, MINUS, plainPercent, pounds, readingTone, signedNumber, signedPercent, signedPoints, signedPounds, telling, volume,
} from "./reading-format";

describe("reading figures", () => {
  it("uses the typographic minus, a plus for gains and no sign or tone for zero", () => {
    expect(MINUS).toBe("\u2212");
    expect(signedPounds(-954.53)).toBe("\u2212£954.53");
    expect(signedPounds(20873.83)).toBe("+£20,873.83");
    expect(signedPounds(-0.004)).toBe("£0.00");
    expect(readingTone(-0.004)).toBeUndefined();
    expect(readingTone(0.006)).toBe("up");
    expect(signedPercent(-0.0044)).toBe("\u22120.44%");
    expect(signedPercent(0.0962)).toBe("+9.62%");
    expect(plainPercent(0.1557)).toBe("15.57%");
    expect(signedPoints(-0.0517)).toBe("\u22125.17 pp");
    expect(signedNumber(-0.005, 3)).toBe("\u22120.005");
    expect(pounds(237863.4, 0)).toBe("£237,863");
    expect(fixed(null)).toBe("—");
  });

  it("shows a third decimal only when it tells values apart", () => {
    expect(telling([2.91, 2.912])).toBe(3);
    expect(telling([2.91, 2.93])).toBe(2);
    expect(telling([2.912])).toBe(2);
  });

  it("writes volume in the volume axis's units", () => {
    expect(volume(34_400_000, "zh")).toBe("3440万");
    expect(volume(34_400_000, "en")).toBe("34.4m");
  });

  it("leads a comparison with its first series and ends with the difference in points", () => {
    const portfolio = { item: { label: "Portfolio TWR", value: "\u22127.81%", tone: "down" as const }, change: -0.0781 };
    const voo = { item: { label: "VOO", value: "\u22122.64%", tone: "down" as const }, change: -0.0264 };
    expect(comparisonFigures([portfolio, voo], "Difference")).toEqual({
      primary: portfolio.item,
      groups: [[voo.item, { label: "Difference", value: "\u22125.17 pp", tone: "down" }]],
    });
    // Several comparisons have no single difference; a missing lead hands over to the next series.
    expect(comparisonFigures([portfolio, voo, voo], "Difference").groups?.[0]).toHaveLength(2);
    expect(comparisonFigures([{ ...portfolio, change: null }, voo], "Difference")).toEqual({ primary: voo.item });
  });
});

describe("reading times", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const iso = /\d{4}-\d{2}-\d{2}|T\d{2}:|GMT|UTC/;

  it("never shows an ISO string or a GMT offset", () => {
    for (const granularity of ["clock", "intraday", "day"] as const) {
      for (const locale of ["zh", "en"] as const) {
        for (const value of ["2026-11-10T14:30:00Z", "2025-06-11T00:00:00Z", "2026-06-11"]) {
          expect(formatReadingTime(value, locale, "Europe/London", granularity, now)).not.toMatch(iso);
        }
      }
    }
  });

  it("matches each range's granularity, with a year only outside the current one", () => {
    const at = "2026-11-10T14:30:00Z";
    expect(formatReadingTime(at, "zh", "Europe/London", "clock", now)).toBe("14:30");
    expect(formatReadingTime(at, "zh", "Europe/London", "intraday", now)).toBe("11月10日 14:30");
    expect(formatReadingTime(at, "en", "Europe/London", "intraday", now)).toBe("10 Nov, 14:30");
    expect(formatReadingTime(at, "en", "Europe/London", "day", now)).toBe("10 Nov");
    expect(formatReadingTime("2025-11-10", "zh", "Europe/London", "day", now)).toBe("2025年11月10日");
    expect(formatReadingTime("2025-11-10", "en", "Europe/London", "day", now)).toBe("10 Nov 2025");
    // Daily dates are calendar days: no midnight clock and no time-zone shift.
    expect(formatReadingTime("2026-06-11", "en", "America/Los_Angeles", "intraday", now)).toBe("11 Jun");
  });

  it("puts an exchange's intraday bars on its own clock", () => {
    expect(formatExchangeTime("2026-11-10T09:30:00-05:00", "America/New_York", "zh", false, now)).toBe("纽约 09:30");
    expect(formatExchangeTime("2026-11-10T09:30:00-05:00", "America/New_York", "zh", true, now)).toBe("11月10日 纽约 09:30");
    expect(formatExchangeTime("2026-11-10T09:30:00-05:00", "America/New_York", "en", true, now)).toBe("10 Nov, New York 09:30");
  });
});
