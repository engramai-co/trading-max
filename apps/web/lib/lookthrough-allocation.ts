export type AllocationRow = {
  allocationPct: number;
  colour: string;
  key: string;
  label: string;
  valueGbp: number;
};

export function reconcileAllocationRows(
  rows: AllocationRow[],
  expectedTotalGbp: number,
  residual: Omit<AllocationRow, "allocationPct" | "valueGbp">,
): { rows: AllocationRow[]; totalValueGbp: number } {
  const validRows = rows.filter(
    (row) => Number.isFinite(row.valueGbp) && row.valueGbp > 0,
  );
  const representedValueGbp = validRows.reduce(
    (sum, row) => sum + row.valueGbp,
    0,
  );
  const toleranceGbp = Math.max(1, expectedTotalGbp * 0.0005);
  const missingValueGbp = expectedTotalGbp - representedValueGbp;
  let completedRows = validRows;
  if (missingValueGbp > toleranceGbp) {
    const residualIndex = validRows.findIndex(
      (row) => row.key === residual.key,
    );
    completedRows =
      residualIndex >= 0
        ? validRows.map((row, index) =>
            index === residualIndex
              ? { ...row, valueGbp: row.valueGbp + missingValueGbp }
              : row,
          )
        : [
            ...validRows,
            {
              ...residual,
              allocationPct: 0,
              valueGbp: missingValueGbp,
            },
          ];
  }
  const totalValueGbp = completedRows.reduce(
    (sum, row) => sum + row.valueGbp,
    0,
  );

  return {
    rows: completedRows.map((row) => ({
      ...row,
      allocationPct:
        expectedTotalGbp > 0 ? row.valueGbp / expectedTotalGbp : 0,
    })),
    totalValueGbp,
  };
}
