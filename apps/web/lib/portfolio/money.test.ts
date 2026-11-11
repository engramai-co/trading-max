import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { portfolioMoney } from "@/lib/portfolio/money";

describe("one money basis for intraday and daily ranges", () => {
  const rows = [[100, 100], [180, 180], [200, 180], [150, 130], [140, 130]];
  const points = (intraday: boolean) => rows.map(([value, flows], i) => ({ date: `2026-01-0${i + 2}`, intraday, total: value, totalNetContributionsGbp: flows }) as NavPoint);
  it("excludes deposits and withdrawals from P&L and drawdowns at either cadence", () => {
    const daily = portfolioMoney(points(false), "total");
    expect(portfolioMoney(points(true), "total")).toEqual(daily);
    expect(daily.pnls).toEqual([0, 0, 20, 20, 10]);
    expect(daily.drawdown).toEqual([0, 0, 0, 0, -10]);
    expect(daily.contributions).toBe(30);
    expect(daily.pnl).toBe(10);
    expect(daily.maxDrawdown).toBe(-10);
    expect(daily.pnlPercents.at(-1)).toBe(0.1);
    expect(daily.drawdownPercents.at(-1)).toBe(-0.1);
  });
  it("does not substitute value changes for missing cash-flow-adjusted results", () => {
    const rows = points(true).map((p) => ({ ...p, totalNetContributionsGbp: null }));
    const money = portfolioMoney(rows, "total");
    expect(money.pnl).toBeNull();
    expect(money.maxDrawdown).toBeNull();
    expect(money.ending).toBe(140);
  });
  it("does not calculate relative percentages from zero opening value", () => {
    const rows = points(true);
    rows[0] = { ...rows[0], total: 0 };
    expect(portfolioMoney(rows, "total").pnlPercents.every((v) => v == null)).toBe(true);
    expect(portfolioMoney(rows.slice(0, 1), "total").pnl).toBeNull();
  });
});

describe("maximum P&L drawdown", () => {
  function history(values: number[], estimates: number[] = []) {
    return portfolioMoney(values.map((total, i) => ({
      date: `2026-01-0${i + 1}`,
      total,
      totalNetContributionsGbp: 100,
      valuationSource: estimates.includes(i) ? "reconstructed" : "broker",
    }) as NavPoint), "total");
  }

  it("has no episode on a rising or flat path", () => {
    expect(history([100, 110, 110])).toMatchObject({ maxDrawdown: 0, drawdownEpisode: null });
  });

  it("locates the last tied peak, the worst trough and the first recovery", () => {
    expect(history([100, 120, 120, 80, 119, 120, 130])).toMatchObject({
      maxDrawdown: -40,
      drawdownEpisode: {
        peak: { date: "2026-01-03", estimated: false },
        trough: { date: "2026-01-04", estimated: false },
        recovery: { date: "2026-01-06", estimated: false },
      },
    });
  });

  it("leaves recovery absent when available observations do not regain the peak", () => {
    expect(history([100, 120, 80, 119]).drawdownEpisode?.recovery).toBeNull();
  });

  it("keeps estimate flags on the readings they qualify", () => {
    expect(history([100, 120, 80, 125], [1, 2]).drawdownEpisode).toMatchObject({
      peak: { estimated: true }, trough: { estimated: true }, recovery: { estimated: false },
    });
  });
});
