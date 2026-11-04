import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/locale-provider";
import { pnlsAt, prepareHistory } from "@/lib/portfolio/prepared";
import type { NavPoint } from "@/lib/types";
import { dayDrivers, driverOpenings, openingLabel, signedPounds } from "./day-drivers";
import { CutoffTag, cutoffLabel } from "./history-coverage";

const day = "2026-11-02";
const dates = ["2026-11-02T07:00:00Z", "2026-11-02T07:10:00Z", "2026-11-02T15:40:00Z"];
const attribution = {
  day,
  accounts: {
    A: {
      since: "2026-11-02T07:10:00Z",
      asOf: "2026-11-02T15:40:00Z",
      contributions: [
        { ticker: "NVDA", name: "Nvidia", contributionGbp: -74 },
        { ticker: "BE", name: "Bloom Energy", contributionGbp: 9 },
      ],
    },
    B: {
      since: "2026-11-02T07:10:00Z",
      asOf: "2026-11-02T15:40:00Z",
      contributions: [
        { ticker: "NVDA", name: "Nvidia", contributionGbp: -20 },
        { ticker: "EQGB", name: "Invesco EQQQ", contributionGbp: 42 },
        { ticker: "AAPL", name: "Apple", contributionGbp: 3 },
      ],
    },
  },
};

describe("dayDrivers", () => {
  // The attribution opened at 07:10, a sync after the chart's first point; the
  // history request reads the P&L at that opening.
  const opened = (pnl: number) => ({ "2026-11-02T07:10:00Z": pnl });

  it("merges a ticker held in both accounts and adds up to the account change", () => {
    // Net P&L 0 at 07:00, 5 at 07:10 (the attribution's opening, stated), -40 at 15:40.
    const drivers = dayDrivers({ attribution, scope: "total", day, dates, pnls: [0, 5, -40], openings: opened(5) })!;
    expect(drivers.accountChange).toBe(-45);
    expect(drivers.named.map((row) => [row.ticker, row.amount])).toEqual([["NVDA", -94], ["EQGB", 42], ["BE", 9]]);
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other;
    expect(shown).toBe(drivers.accountChange);
    expect(drivers.unexplained).toBe(-45 - (-94 + 42 + 9 + 3));
    expect(drivers.material).toBe(false);
  });

  it("scopes to one account and flags a change the positions do not explain", () => {
    const drivers = dayDrivers({ attribution, scope: "isa", day, dates, pnls: [0, 0, 160], openings: opened(0) })!;
    expect(drivers.named.map((row) => row.ticker)).toEqual(["EQGB", "NVDA", "AAPL"]);
    expect(drivers.unexplained).toBe(160 - 25);
    expect(drivers.material).toBe(true);
    // Named positions, other positions and the unattributed share add up to the change.
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other + drivers.unexplained;
    expect(shown).toBe(160);
  });

  it("stays silent without the scoped account or the P&L at its opening", () => {
    expect(dayDrivers({ attribution: { day, accounts: { A: attribution.accounts.A } }, scope: "total", day, dates, pnls: [0, 5, -40], openings: opened(5) })).toBeNull();
    expect(dayDrivers({ attribution, scope: "household", day, dates, pnls: [0, 5, -40], openings: opened(5) })).toBeNull();
    expect(dayDrivers({ attribution, scope: "total", day, dates, pnls: [0, 5, -40] })).toBeNull();
    expect(dayDrivers({ attribution, scope: "total", day, dates, pnls: [0, 5, -40], openings: { "2026-11-02T07:10:00Z": null } })).toBeNull();
    // The figure covers another trading day.
    expect(dayDrivers({ attribution, scope: "total", day: "2026-10-30", dates, pnls: [0, 5, -40], openings: opened(5) })).toBeNull();
  });

  it("names the scoped openings for the history request", () => {
    expect(driverOpenings(attribution, "total")).toEqual(["2026-11-02T07:10:00Z"]);
    expect(driverOpenings({ day, accounts: { A: { ...attribution.accounts.A, since: "2026-11-02T07:10:20Z" }, B: attribution.accounts.B } }, "total"))
      .toEqual(["2026-11-02T07:10:00Z", "2026-11-02T07:10:20Z"]);
    expect(driverOpenings({ day, accounts: { A: attribution.accounts.A } }, "total")).toEqual([]);
    expect(driverOpenings(attribution, "household")).toEqual([]);
    expect(driverOpenings(undefined, "invest")).toEqual([]);
  });
});

describe("the 5D strip measures the window it states", () => {
  /**
   * Account A's 5D history as the overview receives it: the thinned chart, and the
   * P&L the history request reads at the named openings from every observation.
   * £1,000 is contributed throughout.
   */
  const history = (observations: Array<[string, number]>, openings: string[] = []) => {
    const intradayNav = observations.map(([date, value]): NavPoint => ({
      date, intraday: true, valuationSource: "broker", flowStatus: "verified",
      invest: value, isa: null, total: value, household: value, cfd: null,
      investNetContributionsGbp: 1000, totalNetContributionsGbp: 1000,
      investTwr: null, isaTwr: null, totalTwr: null,
      investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
    }));
    const prepared = prepareHistory(
      { runId: "five", dataRevision: "five", brokerAsOf: observations.at(-1)![0], intradayNav },
      { range: "1W", scope: "invest" },
    );
    return {
      day: prepared.chart.history.endDay,
      dates: prepared.chart.history.points.map((p) => p.date),
      pnls: prepared.chart.money.pnls,
      openings: pnlsAt(prepared, openings),
    };
  };
  const window = (since: string, amount: number) => ({
    startDay: "2026-10-28",
    day: "2026-11-03",
    accounts: {
      A: { since, asOf: "2026-11-03T15:00:00Z", contributions: [{ ticker: "XYZ", name: "XYZ Corp", contributionGbp: amount }] },
    },
  });
  // Ten-minute syncs from Wednesday 00:00 to Thursday 06:00, each £1 up, then Tuesday's close.
  const syncs: Array<[string, number]> = [
    ...Array.from({ length: 181 }, (_, step): [string, number] =>
      [new Date(Date.parse("2026-10-28T00:00:00Z") + step * 600_000).toISOString().replace(".000Z", "Z"), 1000 + step]),
    ["2026-11-03T15:00:00Z", 1300],
  ];

  it("shows every later opening of continuous syncs with its exact residual", () => {
    const openings = ["2026-10-29T00:00:00Z", "2026-10-29T00:10:00Z", "2026-10-29T00:20:00Z"];
    // Thinning keeps one reading per 30 minutes: only the 00:20 opening is on the chart.
    expect(openings.filter((at) => history(syncs).dates.includes(at))).toEqual(["2026-10-29T00:20:00Z"]);
    for (const [index, since] of openings.entries()) {
      // From £1,144 + index to £1,300; XYZ explains £100 of it and the rest is unattributed.
      const drivers = dayDrivers({ attribution: window(since, 100), scope: "invest", ...history(syncs, [since]) })!;
      expect([drivers.lateOpening, drivers.accountChange, drivers.unexplained, drivers.material])
        .toEqual([since, 156 - index, 56 - index, true]);
    }
  });

  it("measures the earlier £1,010 / £1,050 / £1,100 case from £1,050", () => {
    const sparse: Array<[string, number]> = [
      ["2026-10-28T00:10:00Z", 1000],
      ["2026-10-28T23:40:00Z", 1010],
      ["2026-10-29T00:10:00Z", 1050],
      ["2026-11-03T15:00:00Z", 1100],
    ];
    const drivers = dayDrivers({ attribution: window("2026-10-29T00:10:00Z", 50), scope: "invest", ...history(sparse, ["2026-10-29T00:10:00Z"]) })!;
    expect([drivers.lateOpening, drivers.accountChange, drivers.unexplained, drivers.material])
      .toEqual(["2026-10-29T00:10:00Z", 50, 0, false]);
    expect(drivers.named.map((row) => [row.ticker, row.amount])).toEqual([["XYZ", 50]]);
    expect(openingLabel(drivers.lateOpening!, "5D", "en", "Europe/London")).toBe("since 29 Oct, 00:10");
  });

  it("hides an opening no observation was taken at", () => {
    // The 00:10 sync left no valuation, though the attribution opened from it.
    const five = history(syncs.filter(([date]) => date !== "2026-10-29T00:10:00Z"), ["2026-10-29T00:10:05Z"]);
    expect(five.openings).toEqual({ "2026-10-29T00:10:05Z": null });
    expect(dayDrivers({ attribution: window("2026-10-29T00:10:05Z", 100), scope: "invest", ...five })).toBeNull();
  });

  it("opens with the window's first observation as before", () => {
    const five = history(syncs);
    const drivers = dayDrivers({ attribution: window("2026-10-28T00:00:00Z", 300), scope: "invest", ...five })!;
    expect([drivers.lateOpening, drivers.accountChange, drivers.unexplained]).toEqual([null, 300, 0]);
    // An opening before the window's, or a figure at its cash-flow cutoff, hides the strip.
    expect(dayDrivers({ attribution: window("2026-10-27T15:00:00Z", 300), scope: "invest", ...five })).toBeNull();
    expect(dayDrivers({ attribution: window("2026-10-28T00:00:00Z", 300), scope: "invest", ...five, cutOff: true })).toBeNull();
  });
});

describe("drivers open where the figure opens", () => {
  // Net P&L 0 at 08:00, 5 at 08:10 and 100 at 15:00: a +£100 headline.
  const chart = ["2026-11-02T08:00:00Z", "2026-11-02T08:10:00Z", "2026-11-02T15:00:00Z"];
  const pnls = [0, 5, 100];
  const account = (since: string, amount: number) => ({
    since,
    asOf: "2026-11-02T15:00:00Z",
    contributions: [{ ticker: "XYZ", name: "XYZ Corp", contributionGbp: amount }],
  });
  const drivers = (accounts: Record<string, ReturnType<typeof account>>, scope: "invest" | "total" = "invest") =>
    dayDrivers({ attribution: { day, accounts }, scope, day, dates: chart, pnls, openings: { "2026-11-02T08:10:00Z": 5 } });

  it("states a later opening, so the drivers read against their own window", () => {
    const late = drivers({ A: account("2026-11-02T08:10:00Z", 95) })!;
    expect([late.lateOpening, late.accountChange, late.material]).toEqual(["2026-11-02T08:10:00Z", 95, false]);
    expect(late.named.map((row) => [row.ticker, row.amount])).toEqual([["XYZ", 95]]);
    expect(openingLabel(late.lateOpening!, "1D", "zh", "Europe/London")).toBe("08:10 起");
    expect(openingLabel(late.lateOpening!, "1D", "en", "Europe/London")).toBe("since 08:10");
    expect(openingLabel(late.lateOpening!, "1D", "en", "Asia/Shanghai")).toBe("since 16:10");
  });

  it("leaves an opening within one sync of the figure's as it was", () => {
    const aligned = drivers({ A: account("2026-11-02T08:04:00Z", 100) })!;
    expect([aligned.lateOpening, aligned.accountChange, aligned.material]).toEqual([null, 100, false]);
  });

  it("hides drivers that opened before the figure", () => {
    expect(drivers({ A: account("2026-11-02T07:50:00Z", 100) })).toBeNull();
  });

  it("hides a combined view whose accounts opened at different times", () => {
    expect(drivers({ A: account("2026-11-02T08:00:00Z", 60), B: account("2026-11-02T08:10:00Z", 35) }, "total")).toBeNull();
    // Openings within one sync of each other are one time, stated once.
    const together = drivers({ A: account("2026-11-02T08:10:20Z", 60), B: account("2026-11-02T08:10:00Z", 35) }, "total")!;
    expect([together.lateOpening, together.accountChange]).toEqual(["2026-11-02T08:10:00Z", 95]);
  });
});

describe("drivers beside the figure they explain", () => {
  const morning = ["2026-11-02T08:00:00Z", "2026-11-02T09:00:00Z"];
  const xyz = (asOf: string, accountDay = day) => ({
    day: accountDay,
    accounts: {
      A: { since: "2026-11-02T08:00:00Z", asOf, contributions: [{ ticker: "XYZ", name: "XYZ Corp", contributionGbp: 100 }] },
    },
  });

  it("tags a figure stopped at 09:00 and hides drivers measured at 15:00", () => {
    // History stops at 09:00 while cash flows await reconciliation; the broker
    // observation and its attribution already reach 15:00.
    const history = { pendingCashFlows: true, cashFlowCutoffAt: "2026-11-02T09:00:00Z" };
    const tag = renderToStaticMarkup(createElement(LocaleProvider, null, createElement(CutoffTag, { history })));
    expect(tag).toBe('<span class="mx-tag mx-tag-warn">截至 09:00</span>');
    expect(cutoffLabel(history, "en", "Europe/London")).toBe("Through 09:00");
    expect(cutoffLabel(history, "en", "Asia/Shanghai")).toBe("Through 17:00");
    expect(cutoffLabel({ pendingCashFlows: true, cashFlowCutoffAt: null }, "en", "Europe/London")).toBe("Cash flows pending");
    expect(cutoffLabel({ pendingCashFlows: false, cashFlowCutoffAt: null }, "en", "Europe/London")).toBeNull();
    expect(dayDrivers({ attribution: xyz("2026-11-02T15:00:00Z"), scope: "invest", day, dates: morning, pnls: [0, 10], cutOff: true })).toBeNull();
    // Once the figure catches up, the same attribution explains it.
    const caughtUp = dayDrivers({ attribution: xyz("2026-11-02T15:00:00Z"), scope: "invest", day, dates: [...morning, "2026-11-02T15:00:00Z"], pnls: [0, 10, 100] })!;
    expect(caughtUp.named.map((row) => [row.ticker, row.amount])).toEqual([["XYZ", 100]]);
    expect(caughtUp.material).toBe(false);
  });

  it("hides an attribution measured before the chart's last point", () => {
    const today = [...morning, "2026-11-02T15:00:00Z"];
    // Two syncs behind the figure.
    expect(dayDrivers({ attribution: xyz("2026-11-02T14:40:00Z"), scope: "invest", day, dates: today, pnls: [0, 10, 100] })).toBeNull();
    // Within one sync of it.
    expect(dayDrivers({ attribution: xyz("2026-11-02T14:56:00Z"), scope: "invest", day, dates: today, pnls: [0, 10, 100] })).not.toBeNull();
    // Measured on the next trading day.
    expect(dayDrivers({ attribution: xyz("2026-11-03T08:00:00Z"), scope: "invest", day, dates: today, pnls: [0, 10, 100] })).toBeNull();
  });

  it("keeps Friday's drivers for a Saturday observation of Friday's trading day", () => {
    const friday = ["2026-11-06T08:00:00Z", "2026-11-06T21:00:00Z"];
    const saturday = {
      day: "2026-11-06",
      accounts: {
        A: { since: "2026-11-06T08:00:00Z", asOf: "2026-11-07T10:00:00Z", contributions: [{ ticker: "XYZ", name: "XYZ Corp", contributionGbp: 100 }] },
      },
    };
    const drivers = dayDrivers({ attribution: saturday, scope: "invest", day: "2026-11-06", dates: friday, pnls: [0, 100] })!;
    expect(drivers.named.map((row) => [row.ticker, row.amount])).toEqual([["XYZ", 100]]);
  });
});

describe("signedPounds", () => {
  it("signs changes only", () => {
    expect(signedPounds(42.2)).toBe("+£42.20");
    expect(signedPounds(-74)).toBe("-£74.00");
    expect(signedPounds(0.001)).toBe("£0.00");
  });
});

