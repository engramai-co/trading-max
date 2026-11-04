import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/locale-provider";
import { dayDrivers, openingLabel, signedPounds } from "./day-drivers";
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
  it("merges a ticker held in both accounts and adds up to the account change", () => {
    // Net P&L 0 at 07:00, 5 at 07:10 (the attribution's opening, stated), -40 at 15:40.
    const drivers = dayDrivers({ attribution, scope: "total", day, dates, pnls: [0, 5, -40] })!;
    expect(drivers.accountChange).toBe(-45);
    expect(drivers.named.map((row) => [row.ticker, row.amount])).toEqual([["NVDA", -94], ["EQGB", 42], ["BE", 9]]);
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other;
    expect(shown).toBe(drivers.accountChange);
    expect(drivers.unexplained).toBe(-45 - (-94 + 42 + 9 + 3));
    expect(drivers.material).toBe(false);
  });

  it("scopes to one account and flags a change the positions do not explain", () => {
    const drivers = dayDrivers({ attribution, scope: "isa", day, dates, pnls: [0, 0, 160] })!;
    expect(drivers.named.map((row) => row.ticker)).toEqual(["EQGB", "NVDA", "AAPL"]);
    expect(drivers.unexplained).toBe(160 - 25);
    expect(drivers.material).toBe(true);
    // Named positions, other positions and the unattributed share add up to the change.
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other + drivers.unexplained;
    expect(shown).toBe(160);
  });

  it("stays silent without the scoped account or a chart point at its opening", () => {
    expect(dayDrivers({ attribution: { day, accounts: { A: attribution.accounts.A } }, scope: "total", day, dates, pnls: [0, 5, -40] })).toBeNull();
    expect(dayDrivers({ attribution, scope: "household", day, dates, pnls: [0, 5, -40] })).toBeNull();
    expect(dayDrivers({ attribution, scope: "invest", day, dates: ["2026-11-02T06:00:00Z"], pnls: [0] })).toBeNull();
    // The figure covers another trading day.
    expect(dayDrivers({ attribution, scope: "total", day: "2026-10-30", dates, pnls: [0, 5, -40] })).toBeNull();
  });

  it("opens the 5D strip with its window and matches a later opening to its thirty-minute bucket", () => {
    const week = (since: string) => ({
      startDay: "2026-10-28",
      day: "2026-11-03",
      accounts: {
        A: { since, asOf: "2026-11-03T15:00:00Z", contributions: [{ ticker: "NVDA", name: "Nvidia", contributionGbp: 30 }] },
      },
    });
    const five = (since: string, dates: string[], extra: { cutOff?: boolean; span?: "1D" | "5D" } = {}) =>
      dayDrivers({ attribution: week(since), scope: "invest", day: "2026-11-03", dates, pnls: [0, 2, 4, 30], span: "5D", ...extra });
    // The window's first observation opens both the chart and the attribution.
    const chart = ["2026-10-28T00:10:00Z", "2026-10-29T00:00:00Z", "2026-10-29T00:30:00Z", "2026-11-03T15:00:00Z"];
    const aligned = five("2026-10-28T00:10:00Z", chart)!;
    expect([aligned.accountChange, aligned.lateOpening]).toEqual([30, null]);
    // A chain that opens on the second day says so. Its 00:10 opening sits in the
    // 00:00 bucket; matching within one sync would skip to 00:30.
    const later = five("2026-10-29T00:10:00Z", chart)!;
    expect([later.accountChange, later.lateOpening]).toEqual([28, "2026-10-29T00:10:00Z"]);
    expect(openingLabel(later.lateOpening!, "5D", "en", "Europe/London")).toBe("since 29 Oct, 00:10");
    expect(five("2026-10-29T00:10:00Z", chart, { span: "1D" })!.accountChange).toBe(26);
    // An opening before the window's, a cut-off figure or a newer one hide the strip.
    expect(five("2026-10-27T15:00:00Z", chart)).toBeNull();
    expect(five("2026-10-28T00:10:00Z", chart, { cutOff: true })).toBeNull();
    expect(five("2026-10-28T00:10:00Z", [...chart.slice(0, 3), "2026-11-03T15:30:00Z"])).toBeNull();
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
    dayDrivers({ attribution: { day, accounts }, scope, day, dates: chart, pnls });

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

