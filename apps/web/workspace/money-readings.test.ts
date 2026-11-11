import { describe, expect, it } from "vitest";
import { moneyEquation, signedPnl } from "./money-readings";

describe("period money readings", () => {
  it.each([
    [35, 20, "+", "+", "+£35.00", "up"],
    [-35, 20, "−", "+", "−£35.00", "down"],
    [0, 20, "+", "+", "£0.00", undefined],
    [35, -20, "+", "−", "+£35.00", "up"],
  ] as const)("uses one operator for P&L %s and contributions %s", (pnl, contributions, pnlOperator, contributionOperator, amount, tone) => {
    expect(signedPnl(pnl)).toEqual({ amount, tone });
    expect(moneyEquation({ opening: 100, contributions, pnl, ending: 100 + contributions + pnl })).toEqual({
      opening: "£100.00",
      contributions: { operator: contributionOperator, amount: "£20.00" },
      pnl: { operator: pnlOperator, amount: `£${Math.abs(pnl)}.00` },
      operator: "=",
      ending: `£${100 + contributions + pnl}.00`,
    });
  });

  it("does not display an equation until all amounts are known", () => {
    expect(moneyEquation({ opening: 100, ending: 125, contributions: null, pnl: null })).toBeNull();
  });

  it("discloses a discrepancy from separately rounding the displayed pence", () => {
    expect(moneyEquation({ opening: 100, ending: 100.008, contributions: 0.004, pnl: 0.004 })?.operator).toBe("≈");
  });
});
