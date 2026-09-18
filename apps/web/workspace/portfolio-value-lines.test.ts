import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { portfolioPerformanceHref, portfolioRange, PORTFOLIO_RANGES, selectPortfolioHistory } from "./portfolio-history";
import { portfolioValueLines } from "./portfolio-value-lines";
import { portfolioMoney } from "./portfolio-money";

const t = (_zh: string, en: string) => en;
const points = [
  { date: "2026-09-18T09:00:00Z", total: 100, totalNetContributionsGbp: 90, isa: 40, isaNetContributionsGbp: 35 },
  { date: "2026-09-18T09:10:00Z", total: 180, totalNetContributionsGbp: 170, isa: 60, isaNetContributionsGbp: 55 },
  { date: "2026-09-18T09:30:00Z", total: 190, totalNetContributionsGbp: 170, isa: 65, isaNetContributionsGbp: 55 },
  { date: "2026-09-18T09:40:00Z", total: 500, totalNetContributionsGbp: null, isa: 200, isaNetContributionsGbp: null },
].map((point) => ({ ...point, intraday: true, valuationSource: "broker" })) as NavPoint[];

describe("overview and performance value layer", () => {
  it("keeps the same verified cutoff, source gap and contribution step", () => {
    const history = selectPortfolioHistory({ intraday: points, scope: "total", range: "3M", requireCashFlows: true });
    expect(history.pendingCashFlows).toBe(true);
    expect(history.latestObservationAt).toBe(points[3].date);
    expect(history.points).toEqual(points.slice(0, 3));
    expect(Date.parse(history.timeline.categories.at(-1)!)).toBe(Date.parse(points[2].date));
    const missing = history.timeline.categories.indexOf("2026-09-18T09:20:00.000Z");
    expect(missing).toBeGreaterThan(-1);
    expect(history.timeline.rowIndexes[missing]).toBeNull();
    const [value, contributions] = portfolioValueLines(history.points, "total", t);
    expect(value.values).toEqual([100, 180, 190]);
    expect(contributions).toMatchObject({ values: [90, 170, 170], dashed: true, step: "end", colour: "accent" });
    expect(value.values.at(-1)! - value.values[0]!).toBe(90);
    expect(portfolioMoney(history.points, "total").pnl).toBe(10);
  });
  it("uses the selected account and never treats an unknown flow as zero", () => {
    const [value, contributions] = portfolioValueLines(points, "isa", t);
    expect(value.values).toEqual([40, 60, 65, 200]);
    expect(contributions.values).toEqual([35, 55, 55, null]);
    const percentages = portfolioValueLines(points, "isa", t, true);
    expect(percentages[0].values).toEqual([0, 0.5, 0.625, 4]);
    expect(percentages[1].values).toEqual([0, 0.5, 0.5, null]);
    expect(portfolioValueLines([{ ...points[0], isa: 0 }], "isa", t, true).every((line) => line.values[0] === null)).toBe(true);
  });
  it.each(PORTFOLIO_RANGES)("preserves %s and the selected account on navigation", (range) => {
    for (const scope of ["total", "invest", "isa"] as const) {
      const destination = new URL(portfolioPerformanceHref(scope, range), "http://localhost");
      expect(destination.pathname).toBe("/analytics");
      expect(destination.searchParams.get("view")).toBe("money");
      expect(destination.searchParams.get("scope") ?? "total").toBe(scope);
      expect(portfolioRange(destination.searchParams.get("range"))).toBe(range);
    }
  });
  it("falls back to 3M for missing or unsupported URL ranges", () => {
    expect(portfolioRange(null)).toBe("3M");
    expect(portfolioRange("unexpected")).toBe("3M");
    expect(portfolioRange("2Y")).toBe("3M");
  });
});
