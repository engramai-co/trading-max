import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/locale-provider";
import { dayDrivers, signedPounds } from "./day-drivers";
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
    // Net P&L 0 at 07:00, 5 at 07:10 (the opening observation), -40 at 15:40.
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

  it("reports an opening later than the chart's first point", () => {
    expect(dayDrivers({ attribution, scope: "total", day, dates, pnls: [0, 5, -40] })!.lateOpening).toBeNull();
    const late = ["2026-11-02T00:00:00Z", ...dates.slice(1)];
    expect(dayDrivers({ attribution, scope: "total", day, dates: late, pnls: [0, 5, -40] })!.lateOpening).toBe("2026-11-02T07:10:00Z");
  });

  it("matches a 5D opening to its thirty-minute chart bucket", () => {
    const week = {
      startDay: "2026-10-28",
      day: "2026-11-03",
      accounts: {
        A: { since: "2026-10-28T00:10:00Z", asOf: "2026-11-03T15:00:00Z", contributions: [{ ticker: "NVDA", name: "Nvidia", contributionGbp: 30 }] },
      },
    };
    const buckets = ["2026-10-28T00:00:00Z", "2026-10-28T00:30:00Z", "2026-11-03T15:00:00Z"];
    // The 00:00 bucket holds the 00:10 opening; one-day matching would skip to 00:30.
    const drivers = dayDrivers({ attribution: week, scope: "invest", day: week.day, dates: buckets, pnls: [0, 4, 30], span: "5D" })!;
    expect(drivers.accountChange).toBe(30);
    expect(drivers.lateOpening).toBeNull();
    expect(dayDrivers({ attribution: week, scope: "invest", day: week.day, dates: buckets, pnls: [0, 4, 30] })!.accountChange).toBe(26);
    // The 5D strip follows the same rule: never beside a cut-off or a newer figure.
    expect(dayDrivers({ attribution: week, scope: "invest", day: week.day, dates: buckets, pnls: [0, 4, 30], span: "5D", cutOff: true })).toBeNull();
    const after = [...buckets.slice(0, 2), "2026-11-03T15:30:00Z"];
    expect(dayDrivers({ attribution: week, scope: "invest", day: week.day, dates: after, pnls: [0, 4, 30], span: "5D" })).toBeNull();
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

