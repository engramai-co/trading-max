import { describe, expect, test } from "vitest";
import { alignResearchIndices, rollingIndexRisk } from "./research-index-chart";
import type { IndexHistory } from "./market-indices-data";

const history = (values: [string, number][], gaps: string[] = []): IndexHistory => ({
  points: values.map(([at, value]) => ({ at, value })), gaps,
} as IndexHistory);

describe("index research chart arithmetic", () => {
  test("three series use their first common date and never fill a gap", () => {
    const result = alignResearchIndices([
      history([["2026-01-01", 10], ["2026-01-02", 20], ["2026-01-05", 24]], ["2026-01-06"]),
      history([["2026-01-02", 40], ["2026-01-05", 60], ["2026-01-06", 65]]),
      history([["2026-01-02", 100], ["2026-01-06", 120]]),
    ]);
    expect(result.dates).toEqual(["2026-01-02", "2026-01-05", "2026-01-06"]);
    expect(result.values).toEqual([[100, 120, null], [100, 150, 162.5], [100, null, 120]]);
  });

  test("rolling volatility needs a gap-free sample and drawdown keeps the high water mark", () => {
    const ascending = Array.from({ length: 22 }, (_, i) => 100 + i);
    const early = rollingIndexRisk(ascending, 252);
    expect(early.drawdown.at(-1)).toBe(0);
    expect(early.volatility[19]).toBeNull();
    expect(early.volatility.at(-1)).toBeGreaterThan(0);
    const gap = rollingIndexRisk([...ascending, null, 119, 121], 252);
    expect(gap.drawdown.slice(-3)).toEqual([null, 119 / 121 - 1, 0]);
    expect(gap.volatility.slice(-3)).toEqual([null, null, null]);
  });
});
