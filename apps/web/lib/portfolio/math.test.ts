import { describe, expect, it } from "vitest";
import { drawdowns, minimumObserved } from "@/lib/portfolio/math";
import { inRange } from "@/lib/portfolio/nav";

describe("period performance", () => {
  it("measures cash-adjusted P&L from observed highs and preserves gaps", () => {
    expect(drawdowns([100, 150, null, 120, 170, 90])).toEqual([
      0,
      0,
      null,
      -30,
      0,
      -80,
    ]);
    expect(minimumObserved([null, null])).toBeNull();
  });
  it("compounds return drawdown instead of subtracting percentages", () => {
    const values = drawdowns([0, 0.2, 0.08, null, 0.32], true);
    expect(values[2]).toBeCloseTo(-0.1);
    expect(values[3]).toBeNull();
    expect(values[4]).toBe(0);
  });
  it("anchors year-to-date to the snapshot year without including last December", () => {
    expect(
      inRange(
        [
          { date: "2024-12-31" },
          { date: "2025-01-01" },
          { date: "2025-03-01" },
        ],
        "YTD",
      ),
    ).toEqual([{ date: "2025-01-01" }, { date: "2025-03-01" }]);
  });
});
