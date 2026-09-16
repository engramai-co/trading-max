import { describe, expect, it } from "vitest";
import {
  estimateGroups,
  impliedGrowthLabel,
  orderedStatement,
  relativeToPrice,
  sensitivityPoints,
} from "./research-display";

describe("research display semantics", () => {
  it("shows the implied-growth solver bounds instead of its sentinel return", () => {
    expect(impliedGrowthLabel(-0.99, "below--30%")).toBe("< −30%");
    expect(impliedGrowthLabel(null, "above-80%")).toBe("> 80%");
    expect(impliedGrowthLabel(0.22, null)).toBe("22.0%");
    expect(impliedGrowthLabel(null, null)).toBe("—");
  });
  it("compares fiscal years separately from quarters and preserves unknown periods", () => {
    const rows = [
      { period: "+1y", avg: 12 },
      { period: "0q", avg: 2 },
      { period: "0y", avg: 10 },
      { period: "+1q", avg: 3 },
      { period: "+2y", avg: 15 },
    ];
    const groups = estimateGroups(rows);
    expect(
      groups.map((group) => [group.key, group.rows.map((row) => row.avg)]),
    ).toEqual([
      ["quarter", [2, 3]],
      ["year", [10, 12]],
      ["other", [15]],
    ]);
    expect(rows[0].period).toBe("+1y");
  });

  it("keeps missing sensitivity values paired with their own input and retains zero values", () => {
    const source = {
      deltas: [-0.1, -0.05, 0, 0.05, 0.1],
      values: [0, null, 80, 100, 130],
    };
    expect(sensitivityPoints(source, 0.2)).toEqual([
      { input: 0.1, delta: -0.1, value: 0 },
      { input: 0.2, delta: 0, value: 80 },
      { input: 0.25, delta: 0.05, value: 100 },
      { input: 0.2 + 0.1, delta: 0.1, value: 130 },
    ]);
    expect(sensitivityPoints(source, null)).toEqual([]);
    expect(
      sensitivityPoints({ deltas: [0, 0.1], values: [50] }, 0.2),
    ).toHaveLength(1);
  });

  it("orders statement totals without losing provider details or changing source rows", () => {
    const rows = [
      { index: "Unusual Item", "2025-12-31": 20 },
      { index: "Net Income", "2025-12-31": 30 },
      { index: "Gross Profit", "2025-12-31": 50 },
      { index: "Total Revenue", "2025-12-31": 100 },
    ];
    const sorted = orderedStatement(rows, "incomeStatement");
    expect(sorted.map((row) => row.index)).toEqual([
      "Total Revenue",
      "Gross Profit",
      "Net Income",
      "Unusual Item",
    ]);
    expect(sorted.at(-1)?.["2025-12-31"]).toBe(20);
    expect(rows[0].index).toBe("Unusual Item");
  });

  it("does not calculate a distance from a missing or nonpositive reference", () => {
    expect(relativeToPrice(102, 100)).toBeCloseTo(0.02);
    expect(relativeToPrice(0, 100)).toBe(-1);
    expect(relativeToPrice(null, 100)).toBeNull();
    expect(relativeToPrice(100, 0)).toBeNull();
    expect(relativeToPrice(100, -50)).toBeNull();
  });
});
