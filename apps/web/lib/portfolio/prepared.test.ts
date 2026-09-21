import { describe, expect, it } from "vitest";
import type { NavPoint } from "@/lib/types";
import { navNumber, type Scope } from "@/lib/portfolio/nav";
import { historyGapSeries, historySeries } from "@/lib/portfolio/series";
import { PORTFOLIO_RANGES, selectPortfolioHistory } from "@/lib/portfolio/history";
import { portfolioMoney } from "@/lib/portfolio/money";
import { decodeTimeline, historyPage, prepareHistory, type HistoryInput } from "@/lib/portfolio/prepared";

function row(date: string, index: number, intraday = true): NavPoint {
  const value = 1000 + Math.sin(index / 19) * 50 + (index === 761 ? -300 : 0);
  const flows = index > 710 ? 920 : 900;
  return { date, intraday, valuationSource: date < "2026-08-10" ? "reconstructed" : "broker",
    flowStatus: "verified", total: value, invest: value * 0.7, isa: value * 0.3,
    cfd: intraday ? null : 70, household: value + (intraday ? 0 : 70),
    totalNetContributionsGbp: flows, investNetContributionsGbp: flows * 0.7, isaNetContributionsGbp: flows * 0.3,
    cfdNetContributionsGbp: intraday ? null : 60, householdNetContributionsGbp: flows + 60,
    investTwr: null, isaTwr: null, totalTwr: null, investDrawdown: null, isaDrawdown: null,
    totalDrawdown: null, cfdProxyDrawdown: null };
}
const input: HistoryInput = { runId: "revision-a", dataRevision: "dataset-a", brokerAsOf: "2026-09-18T17:00:00Z",
  nav: Array.from({ length: 240 }, (_, i) => row(new Date(Date.parse("2026-01-22") + i * 86400000).toISOString().slice(0, 10), i, false)),
  intradayNav: Array.from({ length: 15_000 }, (_, i) => row(new Date(Date.parse("2026-06-06T13:00Z") + i * 600_000).toISOString(), i))
    .filter((p, i) => ![0, 6].includes(new Date(p.date).getUTCDay()) && i % 91 < 87),
};
input.intradayNav!.push(row("2026-09-18T16:00Z", 16000), { ...row("2026-09-18T17:00Z", 16001), totalNetContributionsGbp: null, investNetContributionsGbp: null, isaNetContributionsGbp: null });

describe("indexed history display preserves full-source accounting", () => {
  for (const scope of ["invest", "isa", "total", "household", "cfd"] as Scope[]) {
    it.each(PORTFOLIO_RANGES)(`${scope} / %s preserves accounting, gaps and horizontal positions`, (range) => {
      const original = selectPortfolioHistory({ daily: input.nav, intraday: input.intradayNav, asOf: input.brokerAsOf, range, scope, requireCashFlows: true });
      const fullMoney = portfolioMoney(original.points, scope);
      const { chart } = prepareHistory(input, { range, scope });
      const timeline = decodeTimeline(chart.history.timeline);
      expect(timeline.categories.map(Date.parse)).toEqual(original.timeline.categories.map(Date.parse));
      expect(chart.money).toMatchObject({ opening: fullMoney.opening, ending: fullMoney.ending,
        contributions: fullMoney.contributions, pnl: fullMoney.pnl, maxDrawdown: fullMoney.maxDrawdown });
      expect(chart.history.coverage).toEqual(original.coverage);
      expect(chart.history.pendingCashFlows).toEqual(original.pendingCashFlows);
      const originalDates = original.points.map((p) => p.date);
      const chartDates = chart.history.points.map((p) => p.date);
      const a = [original.points.map((p) => navNumber(p, scope)), original.points.map((p) => navNumber(p, scope, "NetContributionsGbp")), fullMoney.pnls, fullMoney.drawdown];
      const b = [chart.history.points.map((p) => navNumber(p, scope)), chart.history.points.map((p) => navNumber(p, scope, "NetContributionsGbp")), chart.money.pnls, chart.money.drawdown];
      for (let i = 0; i < a.length; i++) {
        const before = historySeries(originalDates, a[i], false, original.timeline);
        const after = historySeries(chartDates, b[i], false, timeline);
        expect(after).toEqual(before);
        expect(historyGapSeries(after)).toEqual(historyGapSeries(before));
      }
    });
  }
  it("reduces chart payload while exact pages retain every eligible record and precision", () => {
    const result = prepareHistory(input, { range: "6M", scope: "total" });
    expect(JSON.stringify(result.chart).length).toBeLessThan(JSON.stringify(result.history).length * 0.5);
    const pages = Array.from({ length: Math.ceil(result.history.points.length / 20) }, (_, i) => historyPage(result, i + 1));
    expect(pages.flatMap((p) => p.points)).toEqual(result.history.points);
    expect(pages.flatMap((p) => p.money.drawdown)).toEqual(result.money.drawdown);
    expect(pages.every((p) => p.runId === input.runId && p.points.length <= 20)).toBe(true);
    expect(historyPage(result, 1000000).points).toEqual([]);
  });
  it("keeps an intraday loss in full-source maximum drawdown even in a daily chart", () => {
    const small = { ...input, nav: [], intradayNav: [100, 70, 110].map((v, i) => ({ ...row(`2026-09-18T1${i}:00Z`, i), total: v, totalNetContributionsGbp: 100 })) };
    const { chart } = prepareHistory(small, { range: "1Y", scope: "total" });
    expect(chart.money.maxDrawdown).toBe(-30);
    expect(chart.money.pnl).toBe(10);
    expect(chart.history.points).toHaveLength(2);
  });
  it.each([0, -100])("does not invent percentage returns for opening %s", (opening) => {
    const { chart } = prepareHistory({ ...input, nav: [], intradayNav: [opening, 30].map((v, i) => ({ ...row(`2026-09-18T1${i}:00Z`, i), total: v })) }, { range: "1D", scope: "total" });
    expect(chart.money.pnlPercents.every((v) => v === null)).toBe(true);
  });
});
