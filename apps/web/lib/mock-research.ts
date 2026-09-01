import type {
  PriceSeriesPoint,
  ResearchLensSnapshot,
  ResearchPriceSeries,
  ResearchShell,
  WatchlistCategory,
} from "@/lib/types";
import { catalogues } from "@/lib/i18n/messages";

const MOCK_AS_OF = "2026-08-21";
const MOCK_GENERATED_AT = "2026-08-21T16:30:00Z";

const mockCategories: WatchlistCategory[] = [
  ["chip-design-ip", "芯片设计与 IP", "Chip design & IP"],
  ["wafer-equipment", "晶圆厂与半导体设备", "Fabs & semiconductor equipment"],
  ["interconnect-network", "光互连与网络", "Optical interconnect & networking"],
  ["ai-data-center", "AI 计算与数据中心", "AI compute & data centres"],
  ["storage-memory", "存储与内存", "Storage & memory"],
  ["cloud-security", "云软件与安全", "Cloud software & security"],
  ["platform-fintech", "平台与数字金融", "Platforms & digital finance"],
  ["power-industrial", "电力与工业基础设施", "Power & industrial infrastructure"],
  ["frontier-tech", "前沿科技", "Frontier technology"],
  ["ev-mobility", "电动汽车与智能出行", "Electric vehicles & mobility"],
].map(([id, labelZh, labelEn], order) => ({
  code: null,
  descriptionEn: labelEn,
  descriptionZh: labelZh,
  id,
  labelEn,
  labelZh,
  order,
  taxonomy: "llm-taxonomy",
}));

const mockCompanies: Array<[string, string, string, string?]> = [
  ["ARM", "Arm Holdings plc ADR", "chip-design-ip", "NASDAQ"],
  ["SNPS", "Synopsys Inc", "chip-design-ip", "NASDAQ"],
  ["MRVL", "Marvell Technology Inc", "chip-design-ip", "NASDAQ"],
  ["AVGO", "Broadcom Inc", "chip-design-ip", "NASDAQ"],
  ["CRDO", "Credo Technology Group", "chip-design-ip", "NASDAQ"],
  ["AMD", "Advanced Micro Devices Inc", "chip-design-ip", "NASDAQ"],
  ["NVDA", "NVIDIA Corp", "chip-design-ip", "NASDAQ"],
  ["ALAB", "Astera Labs Inc", "chip-design-ip", "NASDAQ"],
  ["QCOM", "Qualcomm Inc", "chip-design-ip", "NASDAQ"],
  ["LRCX", "Lam Research Corp", "wafer-equipment", "NASDAQ"],
  ["AMAT", "Applied Materials Inc", "wafer-equipment", "NASDAQ"],
  ["TSEM", "Tower Semiconductor Ltd", "wafer-equipment", "NASDAQ"],
  ["ON", "ON Semiconductor Corp", "wafer-equipment", "NASDAQ"],
  ["COHR", "Coherent Corp", "interconnect-network", "NYSE"],
  ["GLW", "Corning Inc", "interconnect-network", "NYSE"],
  ["NOK", "Nokia Corp ADR", "interconnect-network", "NYSE"],
  ["ANET", "Arista Networks Inc", "interconnect-network", "NYSE"],
  ["AAOI", "Applied Optoelectronics Inc", "interconnect-network", "NASDAQ"],
  ["LITE", "Lumentum Holdings Inc", "interconnect-network", "NASDAQ"],
  ["CSCO", "Cisco Systems Inc", "interconnect-network", "NASDAQ"],
  ["CIEN", "Ciena Corp", "interconnect-network", "NYSE"],
  ["CBRS", "Cambrian Networks", "interconnect-network", "NASDAQ"],
  ["APLD", "Applied Digital Corp", "ai-data-center", "NASDAQ"],
  ["CLS", "Celestica Inc", "ai-data-center", "NYSE"],
  ["DELL", "Dell Technologies Inc", "ai-data-center", "NYSE"],
  ["VRT", "Vertiv Holdings Co", "ai-data-center", "NYSE"],
  ["NBIS", "Nebius Group NV", "ai-data-center", "NASDAQ"],
  ["CRWV", "CoreWeave Inc", "ai-data-center", "NASDAQ"],
  ["SNDK", "Sandisk Corp", "storage-memory", "NASDAQ"],
  ["STX", "Seagate Technology Holdings", "storage-memory", "NASDAQ"],
  ["WDC", "Western Digital Corp", "storage-memory", "NASDAQ"],
  ["MU", "Micron Technology Inc", "storage-memory", "NASDAQ"],
  ["CRWD", "CrowdStrike Holdings Inc", "cloud-security", "NASDAQ"],
  ["IBM", "International Business Machines Corp", "cloud-security", "NYSE"],
  ["ORCL", "Oracle Corp", "cloud-security", "NYSE"],
  ["NET", "Cloudflare Inc", "cloud-security", "NYSE"],
  ["PLTR", "Palantir Technologies Inc", "cloud-security", "NASDAQ"],
  ["APP", "AppLovin Corp", "platform-fintech", "NASDAQ"],
  ["COIN", "Coinbase Global Inc", "platform-fintech", "NASDAQ"],
  ["HOOD", "Robinhood Markets Inc", "platform-fintech", "NASDAQ"],
  ["NFLX", "Netflix Inc", "platform-fintech", "NASDAQ"],
  ["RDDT", "Reddit Inc", "platform-fintech", "NYSE"],
  ["SOFI", "SoFi Technologies Inc", "platform-fintech", "NASDAQ"],
  ["FIG", "Figma Inc", "platform-fintech", "NYSE"],
  ["AAPL", "Apple Inc", "platform-fintech", "NASDAQ"],
  ["GOOGL", "Alphabet Inc Class A", "platform-fintech", "NASDAQ"],
  ["AMZN", "Amazon.com Inc", "platform-fintech", "NASDAQ"],
  ["MSFT", "Microsoft Corp", "platform-fintech", "NASDAQ"],
  ["CAT", "Caterpillar Inc", "power-industrial", "NYSE"],
  ["GEV", "GE Vernova Inc", "power-industrial", "NYSE"],
  ["MP", "MP Materials Corp", "power-industrial", "NYSE"],
  ["OKLO", "Oklo Inc", "power-industrial", "NYSE"],
  ["BE", "Bloom Energy Corp", "power-industrial", "NYSE"],
  ["IREN", "IREN Ltd", "power-industrial", "NASDAQ"],
  ["RKLB", "Rocket Lab Corp", "frontier-tech", "NASDAQ"],
  ["IONQ", "IonQ Inc", "frontier-tech", "NYSE"],
  ["TSLA", "Tesla Inc", "ev-mobility", "NASDAQ"],
  ["XPEV", "XPeng Inc ADR", "ev-mobility", "NYSE"],
];

const mockHeldTickers = new Set([
  "AAPL", "AMZN", "ARM", "AVGO", "BE", "GOOGL", "LITE", "MU", "NVDA", "VRT",
]);

const mockInstruments: ResearchShell["instruments"] = mockCompanies.map(([
  ticker,
  name,
  categoryId,
  exchange = "US",
], order) => ({
  bloombergTicker: `${ticker} US Equity`,
  categoryId,
  exchange,
  exposureGbp: mockHeldTickers.has(ticker) ? 520 + order * 19 : 0,
  figi: `BBG-SYNTHETIC-${ticker}`,
  gics: null,
  hasEarnings: true,
  hasFundamentals: true,
  hasMarket: true,
  hasOptions: true,
  hasTechnical: true,
  hasValuation: true,
  held: mockHeldTickers.has(ticker),
  lastError: null,
  lastRunId: "mock-research-v2",
  name,
  order,
  researchThemeId: categoryId,
  status: order % 11 === 0 ? "partial" : "ready",
  taxonomyDecisionId: `mock-taxonomy-${ticker.toLowerCase()}`,
  taxonomyLabelEn: mockCategories.find((item) => item.id === categoryId)?.labelEn ?? null,
  taxonomyLabelZh: mockCategories.find((item) => item.id === categoryId)?.labelZh ?? null,
  taxonomyStatus: "assigned",
  taxonomyVersion: 1,
  ticker,
  website: "",
}));

export const mockResearchShell: ResearchShell = {
  instruments: mockInstruments,
  status: {
    artifacts: [],
    generatedAt: MOCK_GENERATED_AT,
    overallFreshness: "fresh",
    runId: "mock-research-v2",
  },
  watchlistCategories: mockCategories,
};

const mockPricePoints = buildMockPricePoints();

export async function loadMockResearchLens(
  ticker: string,
  view: ResearchLensSnapshot["view"],
  locale: "zh" | "en",
): Promise<ResearchLensSnapshot> {
  await stagedDelay(520);
  const copy = catalogues[locale].research;
  const latestEvent = {
    asOf: "2026-07-28",
    data: {
      grossMargin: 0.334,
      quarterlyRevenueUsd: 1_065_365_000,
      revenueGrowth: 1.655,
      revenueGuidanceHighUsd: 4_200_000_000,
      revenueGuidanceLowUsd: 3_900_000_000,
    },
    eventType: "earnings",
    sources: [
      {
        name: "Bloom Energy Q2 2026 results",
        url: "https://investor.bloomenergy.com/press-releases/press-release-details/2026/Bloom-Energy-Reports-Record-Second-Quarter-2026-Financial-Results-and-Raises-Full-Year-2026-Guidance/default.aspx",
      },
      {
        name: "Bloom Energy Q2 2026 Form 10-Q/A",
        url: "https://www.sec.gov/Archives/edgar/data/1664703/000162828026050325/be-20260630.htm",
      },
    ],
    summary: locale === "zh"
      ? "Q2 收入 10.65 亿美元，同比增长 165.5%；公司将 2026 年收入指引上调至 39–42 亿美元。"
      : "Q2 revenue reached $1.065bn, up 165.5% year over year; 2026 revenue guidance was raised to $3.9–4.2bn.",
    ticker,
    title: locale === "zh" ? "Q2 2026 收入与指引上调" : "Q2 2026 revenue and guidance raised",
  };
  return {
    alerts: [],
    analyst: null,
    events: [latestEvent],
    financials: null,
    fundamentals: null,
    generatedAt: MOCK_GENERATED_AT,
    latestEvent,
    market: { currency: "USD", spot: 201.45, synthetic: false },
    models: [],
    options: buildMockOptions(ticker),
    portfolioImpact: {
      allocationPct: 0.033,
      country: "United States",
      directValueGbp: 892,
      etfContributors: [],
      exposureValueGbp: 892,
      held: true,
      holdingAccounts: ["A"],
      indirectValueGbp: 0,
      industry: "Electrical Components & Equipment",
      ticker,
      totalValueGbp: 27087,
    },
    runId: "mock-research-v2",
    technical: {
      adrResearch: null,
      asOf: MOCK_AS_OF,
      atrPct: 0.041,
      currency: "USD",
      drawdown52w: -0.176,
      historyCoverage: {
        availableSessions: mockPricePoints.length,
        complete: true,
        firstSession: mockPricePoints[0].date,
        lastSession: mockPricePoints.at(-1)!.date,
        requestedPeriod: "2y",
        warning: null,
      },
      macd: 3.82,
      macdHistogram: 1.16,
      macdSignal: 2.66,
      price: 201.45,
      resistance20: 241.8,
      return20d: 0.071,
      return63d: 0.184,
      rsi: 62.4,
      score: 68,
      signals: [
        copy.mockSignalAboveAverages,
        copy.mockSignalMomentum,
        copy.mockSignalVolatility,
      ],
      sma20: 221.43,
      sma200: 184.28,
      sma50: 207.61,
      state: copy.mockState,
      support20: 211.2,
      ticker,
    },
    ticker,
    timeline: [],
    valuation: {
      analystMedian: 288.5,
      asOf: MOCK_AS_OF,
      baseGrowth: 0.4,
      currency: "USD",
      enterpriseToEbitda: 142.084,
      ev10: 127.46,
      ev10Upside: -0.3673,
      ev5: 102.91,
      ev5Upside: -0.4892,
      forwardPe: 41.237,
      impliedGrowth: 0.6109,
      impliedGrowthBound: null,
      method: "Public-input valuation-v4 preview",
      modelStatus: "indicative",
      modelWarnings: [
        "Public facts use the latest available Q2 2026 filing and 21 August 2026 market snapshot.",
        "Yahoo free cash flow is treated as a levered FCF proxy; it is not verified FCFF.",
        "Reported 165.5% revenue growth is capped at 40% in the base scenario.",
        "Exit-multiple and Gordon terminal values differ materially; this is an indicative range, not a target price.",
      ],
      priceToBook: 8.4,
      priceToSales: 19.0587,
      reportedGrowth: 1.655,
      scenarios: {
        bear: {
          discountRate: 0.18,
          exitFcfMultiple: 15,
          gordonMultiple: 6.6667,
          revenueCagr: 0.32,
          shareCagr: 0.01,
          targetFcfMargin: 0.1208,
          value: 41.28,
          value10: 45.71,
        },
        base: {
          discountRate: 0.168,
          exitFcfMultiple: 20,
          gordonMultiple: 7.2464,
          revenueCagr: 0.4,
          shareCagr: 0.005,
          targetFcfMargin: 0.1708,
          value: 102.91,
          value10: 127.46,
        },
        bull: {
          discountRate: 0.148,
          exitFcfMultiple: 25,
          gordonMultiple: 8.4746,
          revenueCagr: 0.7,
          shareCagr: 0,
          targetFcfMargin: 0.2308,
          value: 479.13,
          value10: 955.86,
        },
      },
      sensitivity: {
        discountRate: {
          deltas: [-0.02, -0.01, 0, 0.01, 0.02],
          values: [111.71, 107.2, 102.91, 98.83, 94.95],
        },
        fcfMargin: {
          deltas: [-0.05, -0.02, 0, 0.02, 0.05],
          values: [73.45, 91.13, 102.91, 114.69, 132.37],
        },
        revenueGrowth: {
          deltas: [-0.1, -0.05, 0, 0.05, 0.1],
          values: [72.53, 86.63, 102.91, 121.61, 142.99],
        },
      },
      spot: 201.45,
      terminalCheck: {
        consistent: false,
        exitMultiple: 20,
        gordonMultiple: 7.2464,
      },
      ticker,
      trailingPe: 261.6234,
      valueRange: { base: 102.91, bear: 41.28, bull: 479.13 },
      valueRange10: { base: 127.46, bear: 45.71, bull: 955.86 },
      verdict: "within-model-range",
    },
    view,
  };
}

export async function loadMockResearchPrices(
  ticker: string,
): Promise<ResearchPriceSeries> {
  await stagedDelay(1_050);
  return {
    asOf: MOCK_AS_OF,
    availableSessions: mockPricePoints.length,
    currency: "USD",
    points: mockPricePoints,
    ticker,
    tradeMarkers: [
      {
        accounts: ["invest"],
        buyAveragePrice: mockPricePoints.at(-18)?.close ?? null,
        buyOrders: 1,
        buyQuantity: 4,
        date: mockPricePoints.at(-18)?.date ?? MOCK_AS_OF,
        kind: "B",
        sellAveragePrice: null,
        sellOrders: 0,
        sellQuantity: 0,
        ticker,
      },
      {
        accounts: ["invest", "isa"],
        buyAveragePrice: mockPricePoints.at(-10)?.close ?? null,
        buyOrders: 1,
        buyQuantity: 2,
        date: mockPricePoints.at(-10)?.date ?? MOCK_AS_OF,
        kind: "T",
        sellAveragePrice: (mockPricePoints.at(-10)?.close ?? 0) + 1,
        sellOrders: 1,
        sellQuantity: 1,
        ticker,
      },
      {
        accounts: ["isa"],
        buyAveragePrice: null,
        buyOrders: 0,
        buyQuantity: 0,
        date: mockPricePoints.at(-3)?.date ?? MOCK_AS_OF,
        kind: "S",
        sellAveragePrice: mockPricePoints.at(-3)?.close ?? null,
        sellOrders: 1,
        sellQuantity: 1,
        ticker,
      },
    ],
  };
}

function stagedDelay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function buildMockOptions(ticker: string): NonNullable<ResearchLensSnapshot["options"]> {
  const spot = 201.45;
  const expiry = "2026-09-18";
  const strikes = [160, 170, 180, 185, 190, 195, 200, 205, 210, 215, 220, 230, 240, 250, 260];
  const contracts = strikes.flatMap((strike) => {
    const distance = (strike - spot) / spot;
    const callMid = Math.max(0.45, Math.max(spot - strike, 0) + 7.2 * Math.exp(-Math.abs(distance) * 8));
    const putMid = Math.max(0.45, Math.max(strike - spot, 0) + 7.5 * Math.exp(-Math.abs(distance) * 8));
    const callOi = Math.round(350 + 4_800 * Math.exp(-Math.abs(strike - 220) / 13));
    const putOi = Math.round(300 + 5_400 * Math.exp(-Math.abs(strike - 190) / 12));
    return [
      {
        ask: round(callMid + 0.18), bid: round(Math.max(0.01, callMid - 0.18)),
        contractSymbol: `${ticker}260918C${String(strike * 1000).padStart(8, "0")}`,
        expiry, impliedVolatility: round(0.47 + Math.abs(distance) * 0.35),
        inTheMoney: strike < spot, lastPrice: round(callMid), openInterest: callOi,
        side: "call" as const, strike, volume: Math.round(callOi * (0.08 + Math.abs(Math.sin(strike)) * 0.08)),
      },
      {
        ask: round(putMid + 0.2), bid: round(Math.max(0.01, putMid - 0.2)),
        contractSymbol: `${ticker}260918P${String(strike * 1000).padStart(8, "0")}`,
        expiry, impliedVolatility: round(0.5 + Math.abs(distance) * 0.4),
        inTheMoney: strike > spot, lastPrice: round(putMid), openInterest: putOi,
        side: "put" as const, strike, volume: Math.round(putOi * (0.07 + Math.abs(Math.cos(strike)) * 0.09)),
      },
    ];
  });
  return {
    callWall: 220,
    capturedAt: "2026-08-21T16:30:00Z",
    contracts,
    expiries: [{
      callIv: 0.49, callOpenInterest: 27_560, callVolume: 3_142, callWall: 220,
      daysToExpiry: 28, expiry, maxPain: 200, putCallOiRatio: 1.08,
      putIv: 0.53, putOpenInterest: 29_765, putVolume: 3_487, putWall: 190,
    }],
    expiryCount: 1,
    gammaFlip: 194,
    gammaProfile: Array.from({ length: 41 }, (_, index) => {
      const profileSpot = 155 + index * 2.5;
      return { netGex: Math.round((profileSpot - 194) * 2_000_000 * Math.exp(-Math.abs(profileSpot - 215) / 50)), spot: profileSpot };
    }),
    gammaRegime: "positive gamma proxy",
    maxPain: 200,
    netGex: 31_400_000,
    putCallOiRatio: 1.08,
    putWall: 190,
    spot,
    ticker,
  };
}

function buildMockPricePoints(): PriceSeriesPoint[] {
  const sessions: PriceSeriesPoint[] = [];
  const cursor = new Date("2024-08-19T12:00:00Z");
  let previous = 152;
  while (sessions.length < 504) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day === 0 || day === 6) continue;
    const index = sessions.length;
    const trend = index * 0.15;
    const cycle = Math.sin(index / 14) * 8 + Math.sin(index / 41) * 13;
    const shock = index > 330 && index < 360 ? -(index - 330) * 0.72 : 0;
    const recovery = index >= 360 ? -21.6 + (index - 360) * 0.24 : 0;
    const close = Math.max(76, 151 + trend + cycle + shock + recovery);
    const open = previous + Math.sin(index * 1.7) * 2.1;
    const high = Math.max(open, close) + 2.6 + Math.abs(Math.sin(index / 3)) * 2.2;
    const low = Math.min(open, close) - 2.2 - Math.abs(Math.cos(index / 4)) * 1.8;
    const sma20 = averageClose(sessions, close, 20);
    const sma50 = averageClose(sessions, close, 50);
    const sma200 = averageClose(sessions, close, 200);
    sessions.push({
      close: round(close),
      date: cursor.toISOString().slice(0, 10),
      high: round(high),
      low: round(low),
      open: round(open),
      sma20,
      sma200,
      sma50,
      volume: Math.round(1_400_000 + Math.abs(Math.sin(index / 9)) * 2_700_000),
    });
    previous = close;
  }
  const scale = 229.94 / sessions.at(-1)!.close;
  return sessions.map((point) => ({
    ...point,
    close: round(point.close * scale),
    high: point.high == null ? null : round(point.high * scale),
    low: point.low == null ? null : round(point.low * scale),
    open: point.open == null ? null : round(point.open * scale),
    sma20: point.sma20 == null ? null : round(point.sma20 * scale),
    sma200: point.sma200 == null ? null : round(point.sma200 * scale),
    sma50: point.sma50 == null ? null : round(point.sma50 * scale),
  }));
}

function averageClose(
  previous: PriceSeriesPoint[],
  current: number,
  window: number,
) {
  if (previous.length + 1 < window) return null;
  const values = [...previous.slice(-(window - 1)).map((point) => point.close), current];
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
