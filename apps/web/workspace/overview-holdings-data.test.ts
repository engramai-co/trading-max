import { describe, expect, it } from "vitest";

import type { Holding } from "@/lib/types";
import { allocationChartColours } from "@/ui/charts/palette";
import { holdingSignals, SIGNAL_LIMIT } from "./attention";
import { COLOURED_HOLDINGS, holdingsLedger } from "./overview-holdings-data";

const holding = (ticker: string, value: number, extra: Partial<Holding> = {}) =>
  ({ ticker, name: ticker + " Inc", account: "A", currentValueGbp: value, costGbp: value, pnlGbp: 0, pnlPct: 0, isFund: false, ...extra }) as Holding;
const tickers = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

describe("overview holdings ledger", () => {
  it("merges accounts, lists the largest eight and closes the rest in one row", () => {
    const holdings = [...tickers.map((ticker, index) => holding(ticker, 1000 - index * 50)), holding("A", 100, { account: "B" })];
    const ledger = holdingsLedger({ holdings, signals: [] });
    expect(ledger.count).toBe(10);
    expect(ledger.rows.map((row) => row.ticker)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(ledger.rows[0]).toMatchObject({ value: 1100, colour: 0 });
    expect(ledger.rows.map((row) => row.colour)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ledger.rest).toMatchObject({ count: 2, value: 1150 });
    expect(ledger.rows.reduce((sum, row) => sum + row.weight, 0) + ledger.rest.weight).toBeCloseTo(1);
  });

  it("gives each flagged holding beyond the eight its own row, colour, segment and signal link", () => {
    const holdings = [...tickers, "K"].map((ticker, index) => holding(ticker, 1000 - index * 50));
    const facts = [{ kind: "score" as const, value: 7, severity: 83 }];
    const ledger = holdingsLedger({
      holdings,
      signals: ["J", "K"].map((ticker) => ({ ticker, facts, href: "/research?ticker=" + ticker + "&view=technical", severity: 83 })),
    });
    expect(ledger.rows.slice(-2)).toMatchObject([
      { ticker: "J", colour: 8, facts, href: "/research?ticker=J&view=technical" },
      { ticker: "K", colour: 9, facts, href: "/research?ticker=K&view=technical" },
    ]);
    // The neutral segment and the closing row are the same holdings.
    expect(ledger.rest).toMatchObject({ count: 1, value: 600 });
    expect(ledger.rows.reduce((sum, row) => sum + row.weight, 0) + ledger.rest.weight).toBeCloseTo(1);
  });

  it("has a palette colour for every row the signal cap can list", () => {
    for (const palette of Object.values(allocationChartColours)) {
      expect(COLOURED_HOLDINGS + SIGNAL_LIMIT).toBeLessThanOrEqual(palette.length);
    }
  });

  it("weights the day's move by the openings the API measured, not by today's position", () => {
    const ledger = holdingsLedger({
      holdings: [
        // Both accounts gained 10% on the shares held all day; B bought more during the session.
        holding("A", 110, { dayChangeGbp: 10, dayChangePct: 0.1, dayChangeDate: "2026-11-10" }),
        holding("A", 210, { account: "B", dayChangeGbp: 10, dayChangePct: 0.1, dayChangeDate: "2026-11-10" }),
        holding("B", 99, { dayChangeGbp: -1, dayChangePct: -0.01, dayChangeDate: "2026-11-09" }),
        holding("C", 50),
      ],
      signals: [],
    });
    expect(ledger.columnDay).toBe("2026-11-10");
    expect(ledger.rows[0].day).toBeCloseTo(0.1);
    expect(ledger.rows[0].dayDate).toBeNull();
    expect(ledger.rows[1]).toMatchObject({ ticker: "B", dayDate: "2026-11-09" });
    expect(ledger.rows[1].day).toBeCloseTo(-0.01);
    expect(ledger.rows[2]).toMatchObject({ ticker: "C", day: null, dayDate: null });
  });

  it("takes the largest position's own share when an opening cannot be inferred", () => {
    const [row] = holdingsLedger({
      holdings: [
        holding("A", 300, { dayChangeGbp: 0, dayChangePct: 0, dayChangeDate: "2026-11-10" }),
        holding("A", 100, { account: "B", dayChangeGbp: 5, dayChangePct: 0.05, dayChangeDate: "2026-11-10" }),
      ],
      signals: [],
    }).rows;
    expect(row.day).toBe(0);
  });

  it("reads research per security and leaves funds without it", () => {
    const ledger = holdingsLedger({
      holdings: [holding("NVDA", 200, { costGbp: 100, pnlGbp: 100 }), holding("VWRP.L", 100, { isFund: true })],
      technical: [{ ticker: "NVDA", score: 64 }, { ticker: "VWRP.L", score: 46 }] as never,
      valuations: [{ ticker: "NVDA", ev5Upside: -0.2 }] as never,
      signals: [],
    });
    expect(ledger.rows[0]).toMatchObject({ ticker: "NVDA", fund: false, score: 64, upside: -0.2, pnl: 1, href: "/research?ticker=NVDA" });
    expect(ledger.rows[1]).toMatchObject({ ticker: "VWRP.L", fund: true, score: null, upside: null });
  });

  it("uses the same unrounded loss for the ledger and signals, with the first position as fallback", () => {
    const holdings = [
      holding("WEIGHTED", 250, { costGbp: 250, pnlGbp: -51.23 }),
      holding("FALLBACK", 200, { costGbp: 0, pnlPct: -0.30123 }),
      holding("WEIGHTED", 50, { account: "B", costGbp: 50, pnlGbp: -10 }),
      holding("FALLBACK", 300, { account: "B", costGbp: Infinity, pnlPct: -0.05, isFund: true }),
      holding("WEIGHTED", 25, { account: "B", costGbp: NaN, pnlGbp: NaN }),
    ];
    const technical = [{ ticker: "FALLBACK", score: 5 }] as never;
    const signals = holdingSignals({ holdings, technical });
    const { rows } = holdingsLedger({ holdings, signals, technical });
    expect(rows.map(({ ticker, pnl, score }) => ({ ticker, pnl, score }))).toEqual([
      { ticker: "FALLBACK", pnl: -0.30123, score: null },
      { ticker: "WEIGHTED", pnl: (-51.23 - 10) / 300, score: null },
    ]);
    for (const { ticker, pnl } of rows) {
      const signal = signals.find((item) => item.ticker === ticker);
      expect(signal?.facts).toEqual([expect.objectContaining({ kind: "loss", value: pnl })]);
    }
  });

  it("stays empty without positions", () => {
    expect(holdingsLedger({ holdings: [], signals: [] })).toMatchObject({ rows: [], count: 0, total: 0, rest: { count: 0, value: 0, weight: 0 } });
  });
});
