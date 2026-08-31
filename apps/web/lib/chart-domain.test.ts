import { describe, expect, it } from "vitest";

import {
  axisTimestampLabels,
  latestNaturalDayIntradayPoints,
  netPnlRate,
  paddedDrawdownDomain,
  paddedPriceDomain,
  paddedReturnDomain,
  portfolioIntradayDisplayIntervalMinutes,
  rebaseMoneyOutcome,
  relativeMoneyRate,
  gapAwareTimeSeries,
  gapBridgeSegments,
  naturalCalendarTimeline,
  naturalDayBounds,
  omitPortfolioWeekendDisplayWindow,
  isPortfolioWeekendDisplayTimestamp,
  sampleTimeBuckets,
  stableMoneyRateBase,
  summarizeTimelineCoverage,
} from "@/lib/chart-domain";

describe("chart percent domains", () => {
  it("keeps the approved intraday display cadence for each short range", () => {
    expect(portfolioIntradayDisplayIntervalMinutes).toEqual({
      "1D": 10,
      "1W": 30,
      "1M": 60,
    });
    expect(Object.values(portfolioIntradayDisplayIntervalMinutes)).not.toContain(5);
  });

  it("expresses net P&L relative to cumulative net contributions", () => {
    expect(netPnlRate(1_500, 25_000)).toBeCloseTo(0.06);
    expect(netPnlRate(-750, 15_000)).toBeCloseTo(-0.05);
  });

  it("does not invent a P&L rate without a positive contribution base", () => {
    expect(netPnlRate(100, 0)).toBeNull();
    expect(netPnlRate(100, -500)).toBeNull();
    expect(netPnlRate(null, 500)).toBeNull();
  });

  it("keeps a flat zero series in a narrow domain around zero", () => {
    expect(paddedReturnDomain([0, 0])).toEqual([-0.001, 0.001]);
    expect(paddedDrawdownDomain([0, 0])).toEqual([-0.001, 0]);
  });

  it("pads real return and drawdown observations without hiding zero", () => {
    expect(paddedReturnDomain([-0.02, 0.03])).toEqual([-0.025, 0.035]);
    expect(paddedDrawdownDomain([-0.1, -0.04])).toEqual([
      -0.10800000000000001,
      0,
    ]);
  });

  it("focuses price domains on the curve and every relevant reference level", () => {
    expect(
      paddedPriceDomain([
        175,
        300,
        236.22,
        350,
        130,
        220,
        209,
      ]),
    ).toEqual([119, 361]);
  });

  it("ignores missing and invalid price references", () => {
    expect(paddedPriceDomain([null, undefined, Number.NaN, 0])).toBeNull();
    expect(paddedPriceDomain([236.22])).toEqual([212, 260]);
  });

  it("keeps only the latest calendar day's intraday anchors", () => {
    const points = [
      { date: "2026-08-07T13:20:00Z", intraday: true, value: 100 },
      { date: "2026-08-08", intraday: false, value: 101 },
      { date: "2026-08-10T13:20:00Z", intraday: true, value: 102 },
      { date: "2026-08-10T13:30:00Z", intraday: true, value: 103 },
    ];
    const valueOf = (point: (typeof points)[number]) => point.value;

    expect(latestNaturalDayIntradayPoints(points, valueOf)).toEqual(
      points.slice(2),
    );
  });

  it("uses Europe/London midnight rather than the UTC date boundary", () => {
    const points = [
      { date: "2026-08-19T22:50:00Z", intraday: true, value: 100 },
      { date: "2026-08-19T23:00:00Z", intraday: true, value: 101 },
      { date: "2026-08-19T23:10:00Z", intraday: true, value: 102 },
    ];

    expect(latestNaturalDayIntradayPoints(points, (point) => point.value)).toEqual(
      points.slice(1),
    );
    expect(naturalDayBounds(points[0].date)).toEqual({
      start: "2026-08-18T23:00:00.000Z",
      end: "2026-08-19T23:00:00.000Z",
    });
  });

  it("keeps natural-day bounds correct across both UK daylight-saving changes", () => {
    expect(naturalDayBounds("2026-03-29T12:00:00Z")).toEqual({
      start: "2026-03-29T00:00:00.000Z",
      end: "2026-03-29T23:00:00.000Z",
    });
    expect(naturalDayBounds("2026-10-25T12:00:00Z")).toEqual({
      start: "2026-10-24T23:00:00.000Z",
      end: "2026-10-26T00:00:00.000Z",
    });
  });

  it("builds a midnight-to-midnight day without fabricating missing values", () => {
    const points = [
      { date: "2026-08-19T05:00:00Z", value: 100 },
      { date: "2026-08-19T22:50:00Z", value: 101 },
    ];
    const timeline = naturalCalendarTimeline(points, 10, 1, true);

    expect(timeline.categories.at(0)).toBe("2026-08-18T23:00:00.000Z");
    expect(timeline.categories.at(-1)).toBe("2026-08-19T23:00:00.000Z");
    expect(timeline.rowIndexes.at(0)).toBeNull();
    expect(timeline.rowIndexes.at(-1)).toBeNull();
    expect(timeline.rowIndexes.filter((index) => index !== null)).toEqual([0, 1]);
  });

  it("keeps adjacent observations connected across local midnight", () => {
    const points = [
      { date: "2026-08-19T22:50:00Z", value: 100 },
      { date: "2026-08-19T23:00:00Z", value: 101 },
    ];
    const timeline = naturalCalendarTimeline(points, 10, 7, false);
    const observed = timeline.rowIndexes
      .map((rowIndex, timelineIndex) => ({ rowIndex, timelineIndex }))
      .filter((point) => point.rowIndex !== null);

    expect(observed).toHaveLength(2);
    expect(observed[1].timelineIndex - observed[0].timelineIndex).toBe(1);
  });

  it("hides only the approved London weekend display window", () => {
    expect(isPortfolioWeekendDisplayTimestamp("2026-08-29T00:59:00Z")).toBe(true);
    expect(isPortfolioWeekendDisplayTimestamp("2026-08-29T01:00:00Z")).toBe(false);
    expect(isPortfolioWeekendDisplayTimestamp("2026-08-30T20:59:00Z")).toBe(false);
    expect(isPortfolioWeekendDisplayTimestamp("2026-08-30T21:00:00Z")).toBe(true);

    expect(isPortfolioWeekendDisplayTimestamp("2026-12-05T01:59:00Z")).toBe(true);
    expect(isPortfolioWeekendDisplayTimestamp("2026-12-05T02:00:00Z")).toBe(false);
    expect(isPortfolioWeekendDisplayTimestamp("2026-12-06T21:59:00Z")).toBe(false);
    expect(isPortfolioWeekendDisplayTimestamp("2026-12-06T22:00:00Z")).toBe(true);
  });

  it("compresses the quiet weekend without turning it into a coverage gap", () => {
    const timeline = omitPortfolioWeekendDisplayWindow({
      categories: [
        "2026-08-29T00:30:00Z",
        "2026-08-29T01:00:00Z",
        "2026-08-30T20:30:00Z",
        "2026-08-30T21:00:00Z",
      ],
      rowIndexes: [0, 1, 2, 3],
    });

    expect(timeline).toEqual({
      categories: ["2026-08-29T00:30:00Z", "2026-08-30T21:00:00Z"],
      rowIndexes: [0, 3],
    });
    expect(summarizeTimelineCoverage(timeline.categories, timeline.rowIndexes).gaps).toEqual([]);
  });

  it("builds a lower-density month timeline and preserves leading coverage gaps", () => {
    const points = [
      { date: "2026-08-22T09:00:00Z", value: 100 },
      { date: "2026-08-22T12:00:00Z", value: 102 },
      { date: "2026-08-24T00:00:00Z", value: 101 },
    ];
    const timeline = naturalCalendarTimeline(points, 180, 31, false, true);
    const summary = summarizeTimelineCoverage(timeline.categories, timeline.rowIndexes);

    expect(timeline.categories.length).toBeGreaterThan(200);
    expect(timeline.categories.length).toBeLessThan(260);
    expect(timeline.rowIndexes.filter((index) => index !== null)).toHaveLength(3);
    expect(summary.status).toBe("partial");
    expect(summary.gaps.at(0)?.startIndex).toBe(0);
  });

  it("summarizes material collection gaps without counting future buckets", () => {
    const categories = Array.from({ length: 10 }, (_, index) => `2026-08-20T0${index}:00:00Z`);
    const summary = summarizeTimelineCoverage(
      categories,
      [null, null, 0, 1, null, null, 2, 3, null, null],
    );

    expect(summary.status).toBe("partial");
    expect(summary.firstObservedIndex).toBe(2);
    expect(summary.lastObservedIndex).toBe(7);
    expect(summary.gaps.map((range) => [range.startIndex, range.endIndex])).toEqual([
      [0, 1],
      [4, 5],
    ]);
    expect(summary.observedRanges.map((range) => [range.startIndex, range.endIndex])).toEqual([
      [2, 3],
      [6, 7],
    ]);
  });

  it("does not elevate one delayed bucket into a material gap", () => {
    const categories = ["a", "b", "c", "d"];
    const summary = summarizeTimelineCoverage(categories, [0, null, 1, 2]);

    expect(summary.status).toBe("complete");
    expect(summary.gaps).toEqual([]);
  });

  it("distinguishes a single observation from an empty timeline", () => {
    const categories = ["a", "b", "c"];

    expect(summarizeTimelineCoverage(categories, [null, 0, null]).status).toBe("single");
    expect(summarizeTimelineCoverage(categories, [null, null, null]).status).toBe("empty");
  });

  it("does not repeat the calendar date for intraday axis labels", () => {
    const labels = axisTimestampLabels(
      [
        "2026-08-07",
        "2026-08-10T07:50:00Z",
        "2026-08-10T14:30:00Z",
        "2026-08-10T22:50:00Z",
      ],
      "en",
    );

    const firstIntraday = labels.get("2026-08-10T07:50:00Z") ?? "";
    const laterIntraday = labels.get("2026-08-10T14:30:00Z") ?? "";
    expect(firstIntraday).toMatch(/Aug/);
    expect(laterIntraday).not.toMatch(/Aug/);
    expect(laterIntraday).toMatch(/\d{2}:\d{2}/);
  });

  it("rebases a selected window and rebuilds drawdown from its own peak", () => {
    const rows = [
      { contributions: 10_000, date: "2026-08-10", drawdown: -700, nav: 11_200, pnl: 1_200 },
      { contributions: 10_300, date: "2026-08-11", drawdown: -550, nav: 11_650, pnl: 1_350 },
      { contributions: 10_300, date: "2026-08-12", drawdown: -650, nav: 11_550, pnl: 1_250 },
    ];

    expect(rebaseMoneyOutcome(rows)).toEqual([
      { ...rows[0], drawdown: 0, pnl: 0 },
      { ...rows[1], drawdown: 0, pnl: 150 },
      { ...rows[2], drawdown: -100, pnl: 50 },
    ]);
  });

  it("uses opening NAV for a selected-period percentage baseline", () => {
    const rows = [
      { contributions: 10_000, date: "2026-08-10", drawdown: 0, nav: 12_000, pnl: 0 },
      { contributions: 10_000, date: "2026-08-11", drawdown: -120, nav: 11_880, pnl: -120 },
    ];

    const base = stableMoneyRateBase(rows, true);
    expect(base).toBe(12_000);
    expect(relativeMoneyRate(-120, base)).toBeCloseTo(-0.01);
  });

  it("gives a zero-value CFD proxy a stable cash-flow percentage base", () => {
    const rows = [
      { contributions: 490, date: "2026-08-10", drawdown: 0, nav: 0, pnl: 0 },
      { contributions: 0.01, date: "2026-08-11", drawdown: -490, nav: 0, pnl: -490 },
    ];

    const base = stableMoneyRateBase(rows, true);
    expect(base).toBe(490);
    expect(relativeMoneyRate(-490, base)).toBe(-1);
  });

  it("samples ten-minute anchors into stable thirty-minute display buckets", () => {
    const points = [0, 10, 20, 30, 40, 50, 60].map((minute) => ({
      date: `2026-08-17T08:${String(minute % 60).padStart(2, "0")}:00Z`,
      value: minute,
    })).map((point, index) => index === 6
      ? { ...point, date: "2026-08-17T09:00:00Z" }
      : point);

    expect(sampleTimeBuckets(points, 30).map((point) => point.value)).toEqual([
      0,
      20,
      50,
      60,
    ]);
  });

  it("breaks a timed series across unobserved recording windows", () => {
    const rows = [
      { date: "2026-08-14T21:50:00Z", value: 100 },
      { date: "2026-08-17T05:00:00Z", value: 105 },
    ];
    const series = gapAwareTimeSeries(rows, (row) => row.value, 45);

    expect(series).toHaveLength(3);
    expect(series[0][1]).toBe(100);
    expect(series[1][1]).toBeNull();
    expect(series[2][1]).toBe(105);
  });

  it("builds isolated bridges only across internal collection gaps", () => {
    const rows = [
      { value: 100 },
      { value: 102 },
      { value: 106 },
      { value: 108 },
    ];
    const bridges = gapBridgeSegments(
      [null, 0, 1, null, null, 2, 3, null],
      rows,
      (row) => row.value,
    );

    expect(bridges).toEqual([{
      fromIndex: 2,
      fromValue: 102,
      toIndex: 5,
      toValue: 106,
    }]);
  });

  it("keeps separate missing windows in separate bridge series", () => {
    const rows = [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }];
    const bridges = gapBridgeSegments(
      [0, null, 1, 2, null, 3],
      rows,
      (row) => row.value,
    );

    expect(bridges).toHaveLength(2);
    expect(bridges[0]).toEqual({ fromIndex: 0, fromValue: 1, toIndex: 2, toValue: 2 });
    expect(bridges[1]).toEqual({ fromIndex: 3, fromValue: 3, toIndex: 5, toValue: 4 });
  });

});
