import { describe, expect, it } from "vitest";
import { researchTimeAxis } from "./research-chart-format";

const at = (day: string) => Date.parse(day + "T00:00:00Z");
const now = at("2026-11-18");

describe("research time axis", () => {
  it("names the month on every label of a short archive, never a bare day", () => {
    const axis = researchTimeAxis(at("2026-11-11"), at("2026-11-18"), "en", now);
    expect(axis.minInterval).toBe(86_400_000);
    expect(axis.formatter(at("2026-11-12"))).toBe("12 Nov");
    expect(researchTimeAxis(at("2026-11-11"), at("2026-11-18"), "zh", now).formatter(at("2026-11-12"))).toBe("11月12日");
    // The year appears only outside the current one.
    expect(axis.formatter(at("2025-12-30"))).toBe("30 Dec 2025");
  });

  it("labels months across a year and names the year on January and before the first January", () => {
    for (const [locale, first, january, month] of [["en", "Dec 2025", "2026", "Feb"], ["zh", "2025年12月", "2026", "2月"]] as const) {
      const axis = researchTimeAxis(at("2025-11-03"), at("2026-11-17"), locale, now);
      expect(axis.minInterval).toBeGreaterThanOrEqual(28 * 86_400_000);
      expect(axis.formatter(at("2025-12-01"))).toBe(first);
      expect(axis.formatter(at("2026-01-01"))).toBe(january);
      expect(axis.formatter(at("2026-02-01"))).toBe(month);
    }
  });

  it("labels years across a long history", () => {
    const axis = researchTimeAxis(at("2019-01-02"), at("2026-11-17"), "zh", now);
    expect(axis.minInterval).toBeGreaterThanOrEqual(365 * 86_400_000);
    expect(axis.formatter(at("2021-01-01"))).toBe("2021");
  });
});
