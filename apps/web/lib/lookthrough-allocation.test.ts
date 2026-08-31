import { describe, expect, it } from "vitest";

import { reconcileAllocationRows } from "@/lib/lookthrough-allocation";

const residual = {
  colour: "#98968a",
  key: "unclassified",
  label: "Unclassified",
};

describe("reconcileAllocationRows", () => {
  it("adds the unclassified remainder against invested assets", () => {
    const result = reconcileAllocationRows(
      [
        {
          allocationPct: 0.367,
          colour: "#657043",
          key: "us",
          label: "United States",
          valueGbp: 9_492,
        },
      ],
      25_883,
      residual,
    );

    expect(result.totalValueGbp).toBe(25_883);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({
      key: "unclassified",
      valueGbp: 16_391,
    });
    expect(result.rows[0].allocationPct).toBeCloseTo(9_492 / 25_883);
    expect(result.rows[1].allocationPct).toBeCloseTo(16_391 / 25_883);
  });

  it("does not invent a residual for rounding noise", () => {
    const result = reconcileAllocationRows(
      [
        {
          allocationPct: 1,
          colour: "#657043",
          key: "all",
          label: "All",
          valueGbp: 999.75,
        },
      ],
      1_000,
      residual,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.totalValueGbp).toBe(999.75);
  });

  it("merges a remaining gap into an existing unresolved slice", () => {
    const result = reconcileAllocationRows(
      [
        {
          allocationPct: 0.4,
          colour: "#657043",
          key: "known",
          label: "Known",
          valueGbp: 400,
        },
        {
          allocationPct: 0.5,
          ...residual,
          valueGbp: 500,
        },
      ],
      1_000,
      residual,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].valueGbp).toBe(600);
    expect(result.totalValueGbp).toBe(1_000);
  });
});
