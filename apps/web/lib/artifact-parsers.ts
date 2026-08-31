/**
 * Pure parsers for normalized API payload fragments.
 *
 * These functions are deliberately free of filesystem and network access so
 * they can be unit tested without granting the web tier filesystem access.
 */
import type {
  LookthroughData,
  OptionSnapshot,
  RiskMetrics,
  TechnicalRow,
  ValuationRow,
} from "@/lib/types";

// Upstream Python artifacts are intentionally schema-flexible across dated runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObject = Record<string, any>;

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function riskMetrics(raw: JsonObject): RiskMetrics {
  return {
    sharpe: asNumber(raw.sharpe_sonia),
    sortino: asNumber(raw.sortino_sonia),
    calmar: asNumber(raw.calmar_ratio),
    informationRatio: asNumber(raw.information_ratio),
    volatility: asNumber(raw.annualized_volatility),
    maxDrawdown: asNumber(raw.max_drawdown),
    currentDrawdown: asNumber(raw.current_drawdown),
    benchmarkReturn: asNumber(raw.benchmark_total_return),
    twr: asNumber(raw.twr_total_return),
    annualizedReturn: asNumber(raw.annualized_return),
    benchmark: String(raw.benchmark_ticker ?? "VOO").replace(/^VUAG$/, "VOO"),
  };
}

export function technicalRows(raw: JsonObject): TechnicalRow[] {
  return (raw.rows ?? []).map((row: JsonObject) => {
    const coverage = row.history_coverage ?? {};
    const adr = row.adr_research;
    return {
      ticker: String(row.ticker),
      asOf: String(row.as_of ?? raw.as_of),
      currency: String(row.currency ?? "USD"),
      historyCoverage: {
        requestedPeriod: String(coverage.requested_period ?? ""),
        availableSessions: asNumber(coverage.available_sessions),
        firstSession: String(coverage.first_session ?? ""),
        lastSession: String(coverage.last_session ?? ""),
        complete:
          coverage.complete === undefined ? true : Boolean(coverage.complete),
        warning:
          coverage.warning === null || coverage.warning === undefined
            ? null
            : String(coverage.warning),
      },
      adrResearch: adr
        ? {
            securityType: "ADR" as const,
            adrTicker: String(adr.adr_ticker ?? ""),
            primaryTicker: String(adr.primary_ticker ?? ""),
            depositary: String(adr.depositary ?? ""),
            ordinarySharesPerAdr: asNumber(adr.ordinary_shares_per_adr),
            adrPerOrdinaryShare: asNumber(adr.adr_per_ordinary_share),
            adrSpotUsd: asNumber(adr.adr_spot_usd),
            primarySpot: asNumber(adr.primary_spot),
            primaryCurrency: String(adr.primary_currency ?? ""),
            fxLocalPerUsd: asNumber(adr.fx_local_per_usd),
            parityUsd: asNumber(adr.parity_usd),
            premiumToParity: asNumber(adr.premium_to_parity),
            availableSessions: asNumber(adr.available_sessions),
            firstTradeSession: String(adr.first_trade_session ?? ""),
            averageVolume20d: asNumber(adr.average_volume_20d),
            averageDollarVolume20d: asNumber(adr.average_dollar_volume_20d),
            arbitrageAssumption: "none" as const,
            warning: String(adr.warning ?? ""),
            ratioSource: String(adr.ratio_source ?? ""),
          }
        : null,
      price: asNumber(row.price),
      score: asNumber(row.technical_score),
      state: String(row.technical_state ?? "—"),
      rsi: nullableNumber(row.momentum?.rsi14),
      macd: nullableNumber(row.momentum?.macd?.line),
      macdSignal: nullableNumber(row.momentum?.macd?.signal),
      macdHistogram: nullableNumber(row.momentum?.macd?.histogram),
      sma20: nullableNumber(row.moving_averages?.sma20),
      sma50: nullableNumber(row.moving_averages?.sma50),
      sma200: nullableNumber(row.moving_averages?.sma200),
      support20: nullableNumber(row.structure?.support20),
      resistance20: nullableNumber(row.structure?.resistance20),
      drawdown52w: nullableNumber(row.structure?.drawdown_from_52w_high),
      return20d: nullableNumber(row.returns?.r_20d),
      return63d: nullableNumber(row.returns?.r_63d),
      atrPct: nullableNumber(row.trend_strength?.atr14_pct),
      signals: Array.isArray(row.signals) ? row.signals.map(String) : [],
    };
  });
}

export function optionRows(raw: JsonObject): OptionSnapshot[] {
  const entries = Object.values(
    (raw.options ?? {}) as Record<string, JsonObject>,
  );
  return entries.map((entry) => {
    const aggregate = entry.aggregate ?? {};
    const gamma = entry.gamma_proxy ?? {};
    return {
      ticker: String(entry.ticker),
      spot: asNumber(entry.spot),
      expiryCount: asNumber(entry.expiry_count),
      capturedAt: String(entry.captured_at_utc ?? ""),
      putCallOiRatio: nullableNumber(aggregate.put_call_oi_ratio),
      callWall: nullableNumber(aggregate.call_oi_wall?.strike),
      putWall: nullableNumber(aggregate.put_oi_wall?.strike),
      maxPain: nullableNumber(aggregate.max_pain_proxy),
      netGex: nullableNumber(aggregate.net_gex_1pct_proxy),
      gammaRegime: gamma.gamma_regime ? String(gamma.gamma_regime) : null,
      gammaFlip: nullableNumber(gamma.gamma_flip_proxy),
      gammaProfile: (gamma.profile ?? []).map((point: JsonObject) => ({
        spot: asNumber(point.spot),
        netGex: asNumber(point.net_gex_1pct),
      })),
      expiries: (entry.expiries ?? []).map((expiry: JsonObject) => ({
        expiry: String(expiry.expiry ?? ""),
        daysToExpiry: nullableNumber(expiry.days_to_expiry),
        callOpenInterest: nullableNumber(expiry.call_open_interest),
        putOpenInterest: nullableNumber(expiry.put_open_interest),
        putCallOiRatio: nullableNumber(expiry.put_call_oi_ratio),
        callVolume: nullableNumber(expiry.call_volume),
        putVolume: nullableNumber(expiry.put_volume),
        callIv: nullableNumber(expiry.call_oi_weighted_iv),
        putIv: nullableNumber(expiry.put_oi_weighted_iv),
        callWall: nullableNumber(expiry.call_oi_wall?.strike),
        putWall: nullableNumber(expiry.put_oi_wall?.strike),
        maxPain: nullableNumber(expiry.max_pain_proxy),
      })),
      contracts: (entry.contracts ?? []).flatMap((contract: JsonObject) => {
        const side = contract.side;
        if (side !== "call" && side !== "put") return [];
        return [{
          expiry: String(contract.expiry ?? ""),
          side,
          contractSymbol: contract.contract_symbol ? String(contract.contract_symbol) : null,
          strike: asNumber(contract.strike),
          lastPrice: nullableNumber(contract.last_price),
          bid: nullableNumber(contract.bid),
          ask: nullableNumber(contract.ask),
          openInterest: nullableNumber(contract.open_interest),
          volume: nullableNumber(contract.volume),
          impliedVolatility: nullableNumber(contract.iv),
          inTheMoney: Boolean(contract.in_the_money),
        }];
      }),
    };
  });
}

export function valuationRows(raw: JsonObject): ValuationRow[] {
  return (raw.rows ?? []).map((row: JsonObject) => {
    const spot = asNumber(row.spot);
    const ev5 = nullableNumber(row.ev5);
    const ev10 = nullableNumber(row.ev10);
    const lenses = (row.lenses ?? {}) as JsonObject;
    return {
      ticker: String(row.t),
      asOf: String(row.as_of ?? raw.as_of ?? ""),
      currency: String(row.ccy ?? "USD"),
      spot,
      ev5,
      ev10,
      analystMedian: nullableNumber(row.med),
      impliedGrowth: nullableNumber(row.impl),
      baseGrowth: nullableNumber(row.base_g),
      verdict: String(row.verdict ?? "—"),
      trailingPe: nullableNumber(lenses.trailingPE),
      forwardPe: nullableNumber(lenses.forwardPE),
      priceToSales: nullableNumber(lenses.priceToSalesTrailing12Months),
      priceToBook: nullableNumber(lenses.priceToBook),
      enterpriseToEbitda: nullableNumber(lenses.enterpriseToEbitda),
      ev5Upside: spot && ev5 !== null ? ev5 / spot - 1 : null,
      ev10Upside: spot && ev10 !== null ? ev10 / spot - 1 : null,
      modelStatus: String(row.model_status ?? "—"),
      modelWarnings: Array.isArray(row.model_warnings)
        ? row.model_warnings.map(String)
        : [],
      method: String(row.method ?? ""),
      reportedGrowth: nullableNumber(row.reported_g),
      impliedGrowthBound: row.implBound ? String(row.implBound) : null,
      valueRange: (row.valueRange ?? {}) as Record<string, number | null>,
      valueRange10: (row.valueRange10 ?? {}) as Record<string, number | null>,
      scenarios: (row.scenarios ?? {}) as ValuationRow["scenarios"],
      terminalCheck: {
        gordonMultiple: nullableNumber(row.terminalCheck?.gordonMultiple),
        exitMultiple: nullableNumber(row.terminalCheck?.exitMultiple),
        consistent: Boolean(row.terminalCheck?.consistent),
      },
      sensitivity: row.sensitivity
        ? {
            discountRate: {
              deltas: Array.isArray(row.sensitivity.discountRate?.deltas)
                ? row.sensitivity.discountRate.deltas.map(Number)
                : [],
              values: Array.isArray(row.sensitivity.discountRate?.values)
                ? row.sensitivity.discountRate.values.map(Number)
                : [],
            },
            revenueGrowth: {
              deltas: Array.isArray(row.sensitivity.revenueGrowth?.deltas)
                ? row.sensitivity.revenueGrowth.deltas.map(Number)
                : [],
              values: Array.isArray(row.sensitivity.revenueGrowth?.values)
                ? row.sensitivity.revenueGrowth.values.map(Number)
                : [],
            },
            fcfMargin: {
              deltas: Array.isArray(row.sensitivity.fcfMargin?.deltas)
                ? row.sensitivity.fcfMargin.deltas.map(Number)
                : [],
              values: Array.isArray(row.sensitivity.fcfMargin?.values)
                ? row.sensitivity.fcfMargin.values.map(Number)
                : [],
            },
          }
        : null,
    };
  });
}

export function emptyLookthrough(
  investedValueGbp: number,
  cashValueGbp: number,
): LookthroughData {
  return {
    available: false,
    generatedAt: null,
    brokerAsOf: null,
    investedValueGbp,
    cashValueGbp,
    directValueGbp: 0,
    etfValueGbp: 0,
    lookthroughValueGbp: 0,
    nonSecurityValueGbp: investedValueGbp,
    lookthroughCoveragePct: 0,
    underlyingCount: 0,
    countryBasis: "country of risk / official fund geography",
    countryAllocation: [],
    industryBasis: "official fund sector allocation / direct equity sector",
    industryAllocation: [],
    gicsSubIndustryBasis:
      "GICS sub-industry assigned by the versioned security master",
    gicsCoveragePct: 0,
    gicsPortfolioCoveragePct: 0,
    gicsEligibleValueGbp: 0,
    gicsClassifiedValueGbp: 0,
    gicsPendingValueGbp: 0,
    gicsNotApplicableValueGbp: investedValueGbp,
    gicsSubIndustryAllocation: [],
    positions: [],
    sources: [],
  };
}
