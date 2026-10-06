import type { LookthroughData } from "@/lib/types";
import type { AllocationSlice } from "./allocation-composition";

/** Preserve the backend's invested-asset denominator, including uncovered value. */
export function companyAllocation(data: Pick<LookthroughData, "positions" | "nonSecurityValueGbp" | "investedValueGbp">) {
  const rows: AllocationSlice[] = data.positions
    .map((position) => ({
      name: position.ticker || position.name,
      fullName: position.name,
      value: position.valueGbp,
      weight: position.allocationPct,
      directValue: position.directValueGbp,
      indirectValue: position.indirectValueGbp,
    }))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  // ETF cash/non-security assets and incomplete look-through are not companies.
  // A separate slice avoids silently expanding the known companies to 100%.
  const coveredWeight = rows.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  const remainderValue = data.nonSecurityValueGbp;
  const remainder = Number.isFinite(remainderValue) && remainderValue > 0.05
    && Number.isFinite(data.investedValueGbp) && data.investedValueGbp > 0
    && coveredWeight < 1
    ? { value: remainderValue, weight: 1 - coveredWeight } : undefined;
  return { rows, remainder };
}
