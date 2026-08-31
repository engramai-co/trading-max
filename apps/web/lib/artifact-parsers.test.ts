import { describe, expect, it } from "vitest";

import {
  asNumber,
  emptyLookthrough,
  nullableNumber,
  optionRows,
  riskMetrics,
  technicalRows,
  valuationRows,
} from "@/lib/artifact-parsers";

describe("asNumber", () => {
  it("parses numeric strings and numbers", () => {
    expect(asNumber("12.5")).toBe(12.5);
    expect(asNumber(3)).toBe(3);
  });

  it("falls back for non-finite input", () => {
    expect(asNumber(null)).toBe(0);
    expect(asNumber("abc")).toBe(0);
    expect(asNumber(Infinity)).toBe(0);
    expect(asNumber(undefined, -1)).toBe(-1);
  });
});

describe("nullableNumber", () => {
  it("distinguishes missing values from zero", () => {
    expect(nullableNumber(0)).toBe(0);
    expect(nullableNumber(null)).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber("   ")).toBeNull();
    expect(nullableNumber("abc")).toBeNull();
  });
});

describe("riskMetrics", () => {
  it("maps the Python snake_case contract", () => {
    const metrics = riskMetrics({
      sharpe_sonia: 0.65,
      sortino_sonia: 0.92,
      calmar_ratio: 0.67,
      information_ratio: 0.39,
      annualized_volatility: 0.568,
      max_drawdown: -0.411,
      current_drawdown: -0.273,
      benchmark_total_return: 0.1,
      twr_total_return: 0.299,
      annualized_return: 0.18,
      benchmark_ticker: "VUAG",
    });

    expect(metrics.sharpe).toBe(0.65);
    expect(metrics.sortino).toBe(0.92);
    expect(metrics.maxDrawdown).toBeCloseTo(-0.411);
    expect(metrics.benchmark).toBe("VOO");
  });

  it("defaults the benchmark when absent", () => {
    expect(riskMetrics({}).benchmark).toBe("VOO");
  });
});

describe("technicalRows", () => {
  const payload = {
    as_of: "2026-08-05",
    rows: [
      {
        ticker: "BE",
        price: 228.11,
        technical_score: 57,
        technical_state: "偏强",
        momentum: { rsi14: 51.08, macd: { line: 1.2, signal: 0.8, histogram: 0.4 } },
        moving_averages: { sma20: 190, sma50: 180, sma200: 150 },
        structure: { support20: 180, resistance20: 220, drawdown_from_52w_high: -0.129 },
        returns: { r_20d: 0.041, r_63d: 0.2 },
        trend_strength: { atr14_pct: 0.043 },
        signals: ["价在200日线上"],
      },
    ],
  };

  it("maps nested indicator groups", () => {
    const [row] = technicalRows(payload);
    expect(row.ticker).toBe("BE");
    expect(row.score).toBe(57);
    expect(row.rsi).toBeCloseTo(51.08);
    expect(row.macdHistogram).toBeCloseTo(0.4);
    expect(row.sma200).toBe(150);
    expect(row.drawdown52w).toBeCloseTo(-0.129);
    expect(row.signals).toEqual(["价在200日线上"]);
  });

  it("inherits the snapshot as_of when a row omits it", () => {
    expect(technicalRows(payload)[0].asOf).toBe("2026-08-05");
  });

  it("treats history coverage as complete unless stated otherwise", () => {
    expect(technicalRows(payload)[0].historyCoverage.complete).toBe(true);
  });

  it("preserves an explicit incomplete-coverage warning", () => {
    const [row] = technicalRows({
      rows: [
        {
          ticker: "SKHY",
          history_coverage: {
            requested_period: "3y",
            available_sessions: 590,
            first_session: "2024-03-27",
            last_session: "2026-08-04",
            complete: false,
            warning: "insufficient ADR history",
          },
        },
      ],
    });

    expect(row.historyCoverage.complete).toBe(false);
    expect(row.historyCoverage.availableSessions).toBe(590);
    expect(row.historyCoverage.warning).toBe("insufficient ADR history");
  });

  it("maps ADR research without assuming arbitrage convergence", () => {
    const [row] = technicalRows({
      rows: [
        {
          ticker: "TSM",
          adr_research: {
            adr_ticker: "TSM",
            primary_ticker: "2330.TW",
            depositary: "Citibank",
            ordinary_shares_per_adr: 5,
            premium_to_parity: 0.18,
            ratio_source: "https://example.invalid/ratio",
          },
        },
      ],
    });

    expect(row.adrResearch).not.toBeNull();
    expect(row.adrResearch?.securityType).toBe("ADR");
    expect(row.adrResearch?.arbitrageAssumption).toBe("none");
    expect(row.adrResearch?.ordinarySharesPerAdr).toBe(5);
    expect(row.adrResearch?.premiumToParity).toBeCloseTo(0.18);
  });

  it("returns null ADR research for ordinary listings", () => {
    expect(technicalRows(payload)[0].adrResearch).toBeNull();
  });

  it("returns an empty list when rows are absent", () => {
    expect(technicalRows({})).toEqual([]);
  });
});

describe("optionRows", () => {
  it("maps walls, gamma and the profile curve", () => {
    const [row] = optionRows({
      options: {
        BE: {
          ticker: "BE",
          spot: 200,
          expiry_count: 4,
          captured_at_utc: "2026-08-05T18:00:00Z",
          aggregate: {
            put_call_oi_ratio: 0.8,
            call_oi_wall: { strike: 220 },
            put_oi_wall: { strike: 180 },
            max_pain_proxy: 195,
            net_gex_1pct_proxy: 12345,
          },
          gamma_proxy: {
            gamma_regime: "positive",
            gamma_flip_proxy: 185,
            profile: [
              { spot: 180, net_gex_1pct: -100 },
              { spot: 200, net_gex_1pct: 100 },
            ],
          },
        },
      },
    });

    expect(row.callWall).toBe(220);
    expect(row.putWall).toBe(180);
    expect(row.maxPain).toBe(195);
    expect(row.gammaRegime).toBe("positive");
    expect(row.gammaFlip).toBe(185);
    expect(row.gammaProfile).toHaveLength(2);
    expect(row.gammaProfile[1].netGex).toBe(100);
  });

  it("keeps missing walls null instead of zero", () => {
    const [row] = optionRows({
      options: { BE: { ticker: "BE", spot: 200, aggregate: {}, gamma_proxy: {} } },
    });

    expect(row.callWall).toBeNull();
    expect(row.putWall).toBeNull();
    expect(row.gammaRegime).toBeNull();
    expect(row.gammaProfile).toEqual([]);
  });

  it("returns an empty list when options are absent", () => {
    expect(optionRows({})).toEqual([]);
  });
});

describe("valuationRows", () => {
  it("derives upside from spot", () => {
    const [row] = valuationRows({
      as_of: "2026-08-05",
      rows: [
        {
          t: "BE",
          ccy: "USD",
          spot: 200,
          ev5: 220,
          ev10: 250,
          med: 230,
          impl: 0.2,
          base_g: 0.15,
          verdict: "很贵·需大幅超预期",
        },
      ],
    });

    expect(row.ticker).toBe("BE");
    expect(row.ev5Upside).toBeCloseTo(0.1);
    expect(row.ev10Upside).toBeCloseTo(0.25);
    expect(row.analystMedian).toBe(230);
    expect(row.verdict).toBe("很贵·需大幅超预期");
  });

  it("avoids dividing by a zero spot", () => {
    const [row] = valuationRows({ rows: [{ t: "X", spot: 0, ev5: 10, ev10: 20 }] });
    expect(row.ev5Upside).toBeNull();
    expect(row.ev10Upside).toBeNull();
  });

  it("keeps market multiples when model values are unavailable", () => {
    const [row] = valuationRows({
      rows: [
        {
          t: "IONQ",
          spot: 44,
          lenses: {
            forwardPE: -36.5,
            priceToSalesTrailing12Months: 67.3,
            priceToBook: 3.3,
            enterpriseToEbitda: -17.5,
          },
        },
      ],
    });

    expect(row.ev5).toBeNull();
    expect(row.ev10).toBeNull();
    expect(row.forwardPe).toBe(-36.5);
    expect(row.priceToSales).toBe(67.3);
    expect(row.priceToBook).toBe(3.3);
    expect(row.enterpriseToEbitda).toBe(-17.5);
  });
});

describe("emptyLookthrough", () => {
  it("reports the uninvestable remainder rather than fake coverage", () => {
    const empty = emptyLookthrough(1000, 200);
    expect(empty.available).toBe(false);
    expect(empty.investedValueGbp).toBe(1000);
    expect(empty.cashValueGbp).toBe(200);
    expect(empty.nonSecurityValueGbp).toBe(1000);
    expect(empty.lookthroughCoveragePct).toBe(0);
    expect(empty.positions).toEqual([]);
  });
});
