import { describe, expect, it } from "vitest";
import { dividendSummary } from "./research-dividends";

describe("comparable dividends", () => {
  const rows = [
    { date: "2024-03-01", amount: 0.2 },
    { date: "2024-09-01", amount: 0.2 },
    { date: "2025-03-01", amount: 0.25 },
    { date: "2025-09-01", amount: 0.25 },
    { date: "2026-03-01", amount: 0.3 },
    { date: "2026-09-01", amount: 0.3 },
  ];
  it("keeps YTD out of the complete-year trend and matches last year's cutoff", () => {
    const result = dividendSummary(rows, "2026-06-30", false)!;
    expect(result.annual).toEqual([
      { date: "2024", value: 0.4 },
      { date: "2025", value: 0.5 },
    ]);
    expect(result.ytd).toBe(0.3);
    expect(result.priorYtd).toBe(0.25);
    expect(result.ytdChange).toBeCloseTo(0.2);
    expect(result.ttm).toBe(0.55);
    expect(result.trailing.at(-1)).toEqual({ date: "2026-06-30", value: 0.55 });
  });
  it("does not claim complete amounts when the first year was truncated", () => {
    const result = dividendSummary(rows.slice(1), "2025-06-30", true)!;
    expect(result.annual).toEqual([]);
    expect(result.priorYtd).toBeNull();
    expect(result.ttm).toBeNull();
    expect(result.ytdChange).toBeNull();
  });
  it("does not invent dates, divide by zero, or count future ex-dates", () => {
    expect(dividendSummary(rows, "")).toBeNull();
    expect(
      dividendSummary(
        [{ date: "2026-01-01", amount: 0.5 }],
        "2026-09-01",
        false,
      )?.ytdChange,
    ).toBeNull();
    expect(dividendSummary(rows, "2023-01-01")).toBeNull();
  });
});
