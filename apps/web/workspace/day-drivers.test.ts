import { describe, expect, it } from "vitest";
import { dayDrivers, signedPounds } from "./day-drivers";

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
    const drivers = dayDrivers({ attribution, scope: "total", dates, pnls: [0, 5, -40] })!;
    expect(drivers.accountChange).toBe(-45);
    expect(drivers.named.map((row) => [row.ticker, row.amount])).toEqual([["NVDA", -94], ["EQGB", 42], ["BE", 9]]);
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other;
    expect(shown).toBe(drivers.accountChange);
    expect(drivers.unexplained).toBe(-45 - (-94 + 42 + 9 + 3));
    expect(drivers.material).toBe(false);
  });

  it("scopes to one account and flags a change the positions do not explain", () => {
    const drivers = dayDrivers({ attribution, scope: "isa", dates, pnls: [0, 0, 160] })!;
    expect(drivers.named.map((row) => row.ticker)).toEqual(["EQGB", "NVDA", "AAPL"]);
    expect(drivers.unexplained).toBe(160 - 25);
    expect(drivers.material).toBe(true);
    // Named positions, other positions and the unattributed share add up to the change.
    const shown = drivers.named.reduce((total, row) => total + row.amount, 0) + drivers.other + drivers.unexplained;
    expect(shown).toBe(160);
  });

  it("stays silent without the scoped account or a chart point at its opening", () => {
    expect(dayDrivers({ attribution: { day, accounts: { A: attribution.accounts.A } }, scope: "total", dates, pnls: [0, 5, -40] })).toBeNull();
    expect(dayDrivers({ attribution, scope: "household", dates, pnls: [0, 5, -40] })).toBeNull();
    expect(dayDrivers({ attribution, scope: "invest", dates: ["2026-11-02T06:00:00Z"], pnls: [0] })).toBeNull();
  });

  it("reports an opening later than the chart's first point", () => {
    expect(dayDrivers({ attribution, scope: "total", dates, pnls: [0, 5, -40] })!.lateOpening).toBeNull();
    const late = ["2026-11-02T00:00:00Z", ...dates.slice(1)];
    expect(dayDrivers({ attribution, scope: "total", dates: late, pnls: [0, 5, -40] })!.lateOpening).toBe("2026-11-02T07:10:00Z");
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
    const drivers = dayDrivers({ attribution: week, scope: "invest", dates: buckets, pnls: [0, 4, 30], span: "5D" })!;
    expect(drivers.accountChange).toBe(30);
    expect(drivers.lateOpening).toBeNull();
    expect(dayDrivers({ attribution: week, scope: "invest", dates: buckets, pnls: [0, 4, 30] })!.accountChange).toBe(26);
  });
});

describe("signedPounds", () => {
  it("signs changes only", () => {
    expect(signedPounds(42.2)).toBe("+£42.20");
    expect(signedPounds(-74)).toBe("-£74.00");
    expect(signedPounds(0.001)).toBe("£0.00");
  });
});

