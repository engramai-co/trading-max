import { describe, expect, it } from "vitest";
import type { LookthroughPosition } from "@/lib/types";
import { companyAllocation } from "./company-allocation";

const position = (ticker: string | null, value: number, overrides: Partial<LookthroughPosition> = {}): LookthroughPosition => ({
  ticker, name: ticker ? `${ticker} Corporation` : "Company without ticker",
  valueGbp: value, allocationPct: value / 10000,
  directValueGbp: value * 0.6, indirectValueGbp: value * 0.4,
  entityId: ticker || "unknown", isin: null, country: null,
  etfContributors: [], gicsStatus: "pending-identity", identitySource: "synthetic",
  resolutionConfidence: 1, resolutionMethod: "ticker", securityType: "EQUITY",
  ...overrides,
});

describe("company allocation", () => {
  it("uses combined exposure and backend weights, sorted without mutating the snapshot", () => {
    const positions = [position("SMALL", 1000), position("LARGE", 7000)];
    const result = companyAllocation({ positions, investedValueGbp: 10000, nonSecurityValueGbp: 2000 });
    expect(result.rows[0]).toEqual({
      name: "LARGE", fullName: "LARGE Corporation", value: 7000, weight: 0.7,
      directValue: 4200, indirectValue: 2800,
    });
    expect(result.remainder?.value).toBe(2000);
    expect(result.remainder?.weight).toBeCloseTo(0.2);
    expect(positions[0].ticker).toBe("SMALL");
  });

  it("preserves full records, including fund-only companies and missing tickers", () => {
    const result = companyAllocation({
      positions: [position(null, 1000), position("FUND", 9000, { directValueGbp: 0, indirectValueGbp: 9000 })],
      investedValueGbp: 10000, nonSecurityValueGbp: 0,
    });
    expect(result.rows[0].indirectValue).toBe(9000);
    expect(result.rows[1].name).toBe("Company without ticker");
    expect(result.remainder).toBeUndefined();
  });

  it("does not renormalize partially covered companies or count broker cash", () => {
    const result = companyAllocation({
      positions: [position("KNOWN", 8000, { allocationPct: 0.8 })],
      investedValueGbp: 10000, nonSecurityValueGbp: 2000,
    });
    expect(result.rows[0].weight).toBe(0.8);
    expect(result.remainder?.weight).toBeCloseTo(0.2);
  });

  it("does not invent negative or rounding-dust residuals", () => {
    expect(companyAllocation({ positions: [position("ALL", 10000)], investedValueGbp: 10000, nonSecurityValueGbp: -2 }).remainder).toBeUndefined();
    expect(companyAllocation({ positions: [position("ALL", 10000)], investedValueGbp: 10000, nonSecurityValueGbp: 0.01 }).remainder).toBeUndefined();
    expect(companyAllocation({ positions: [], investedValueGbp: 0, nonSecurityValueGbp: 0 }).rows).toEqual([]);
  });
});
