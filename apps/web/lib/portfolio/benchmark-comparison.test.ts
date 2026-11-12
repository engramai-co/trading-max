import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { benchmarkComparison } from "./benchmark-comparison";

const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
const nav = dates.map((date, i) => ({ date, totalTwr: i === 2 ? null : 0.01 * i } as NavPoint));

describe("benchmark comparison", () => {
  it("starts both series at the first usable shared date", () => {
    const result = benchmarkComparison(nav, "total", {
      VOO: [{ date: dates[1], close: 50 }, { date: dates[2], close: 75 }, { date: dates[3], close: 60 }],
    }, ["VOO"]);
    expect(result.points.map((point) => point.date)).toEqual([dates[1], dates[3]]);
    expect(result.comparisons[0].values[0]).toBe(0);
    expect(result.comparisons[0].values[1]).toBeCloseTo(0.2);
    expect(result.missing).toBe(false);
  });

  it("keeps the portfolio curve if the benchmark overlaps just one usable date", () => {
    const result = benchmarkComparison(nav, "total", {
      VOO: [{ date: dates[1], close: 50 }, { date: dates[2], close: 75 }, { date: dates[3], close: 0 }],
    }, ["VOO"]);
    expect(result.points.map((point) => point.date)).toEqual([dates[0], dates[1], dates[3]]);
    expect(result.comparisons).toEqual([]);
    expect(result.missing).toBe(true);
  });

  it("reports a missing benchmark while preserving those with a shared basis", () => {
    const result = benchmarkComparison(nav, "total", {
      VOO: [{ date: dates[0], close: 50 }, { date: dates[3], close: 60 }],
    }, ["VOO", "QQQ"]);
    expect(result.points.map((point) => point.date)).toEqual([dates[0], dates[3]]);
    expect(result.comparisons.map((line) => line.name)).toEqual(["VOO"]);
    expect(result.missing).toBe(true);
  });
});
