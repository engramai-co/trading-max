import { describe, expect, it } from "vitest";

import { priceChartRangePoints, priceChartWindow } from "@/lib/price-chart";

const points = Array.from({ length: 504 }, (_, index) => ({
  date: `session-${String(index + 1).padStart(3, "0")}`,
}));

describe("research price chart windows", () => {
  it("keeps the overview chart fixed to its labelled one-month range", () => {
    expect(priceChartRangePoints(points, "1m")).toEqual(points.slice(-21));
  });

  it.each([
    ["1m", 483],
    ["3m", 441],
    ["6m", 378],
    ["1y", 252],
    ["2y", 0],
    ["max", 0],
  ] as const)("opens %s at the latest expected session", (range, startIndex) => {
    expect(priceChartWindow(points, range)).toEqual({
      endIndex: 503,
      endValue: "session-504",
      startIndex,
      startValue: points[startIndex].date,
    });
  });

  it("uses every available session when the selected range exceeds coverage", () => {
    expect(priceChartWindow(points.slice(0, 12), "1m")).toEqual({
      endIndex: 11,
      endValue: "session-012",
      startIndex: 0,
      startValue: "session-001",
    });
  });

  it("does not create an interactive window without a drawable series", () => {
    expect(priceChartWindow([], "1m")).toBeNull();
    expect(priceChartWindow(points.slice(0, 1), "1m")).toBeNull();
  });
});
