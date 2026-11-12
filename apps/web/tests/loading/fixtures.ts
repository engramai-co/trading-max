import { portfolioRange } from "@/lib/portfolio/history";
import { historyPage, pnlsAt, prepareHistory } from "@/lib/portfolio/prepared";
import type { NavPoint } from "@/lib/types";

export const ticker = "SYNT";
const runId = "synthetic-loading";
const dataRevision = "synthetic";
const day = "2026-01-30";
const asOf = day + "T20:00:00Z";
const sessionOpen = day + "T14:30:00Z";
const iso = (ms: number) => new Date(ms).toISOString();
const dailyDates = Array.from({ length: 125 }, (_, i) => new Date(Date.UTC(2026, 0, 30 - 124 + i)))
  .filter((date) => date.getUTCDay() % 6 !== 0).map((date) => date.toISOString().slice(0, 10));
const times = Array.from({ length: 34 }, (_, i) => iso(Date.parse(sessionOpen) + i * 600_000));
function point(date: string, i: number, intraday: boolean): NavPoint {
  const value = 9_900 + i * (intraday ? 2 : 9) + Math.sin(i / 3) * 25;
  return {
    date, total: value, invest: value, isa: null, household: value, cfd: null,
    intraday, valuationSource: "broker", cadenceSeconds: 600, flowStatus: "verified",
    investNetContributionsGbp: 9_000, totalNetContributionsGbp: 9_000,
    investTwr: i * 0.001, totalTwr: i * 0.001, isaTwr: null,
    investDrawdown: -0.001 * (i % 5), totalDrawdown: -0.001 * (i % 5), isaDrawdown: null, cfdProxyDrawdown: null,
  };
}
const nav = dailyDates.map((date, i) => point(date, i, false));
const intradayNav = times.map((date, i) => point(date, i, true));
const history = { runId, dataRevision, brokerAsOf: asOf, nav, intradayNav };
const holdings = Array.from({ length: 12 }, (_, i) => ({
  ticker: i === 0 ? ticker : "SYN" + i, name: "Synthetic Company " + (i + 1), account: "A",
  currency: "GBP", currentValueGbp: 200 + i * 25, allocationPct: 3 + i * 0.5,
  costGbp: 200 + i * 20, pnlGbp: i * 5, pnlPct: i * 0.01,
}));
const summary = {
  runId, dataRevision, brokerAsOf: asOf, totalValueGbp: 10_000,
  totalInvestedGbp: 8_000, totalCashGbp: 2_000, totalUnrealizedPnlGbp: 600,
  accounts: [{ code: "A", isInvestable: true, totalValueGbp: 10_000, cashGbp: 2_000 }],
};
const lookthrough = {
  available: true, brokerAsOf: asOf, generatedAt: asOf,
  underlyingCount: holdings.length, sources: [], lookthroughCoveragePct: 1, gicsCoveragePct: 1,
  countryAllocation: [], industryAllocation: [], gicsSubIndustryAllocation: [],
  positions: holdings.map((h) => ({
    entityId: h.ticker, ticker: h.ticker, name: h.name, country: "GB",
    allocationPct: h.allocationPct / 100, valueGbp: h.currentValueGbp,
    directValueGbp: h.currentValueGbp * 0.75, indirectValueGbp: h.currentValueGbp * 0.25,
  })),
};
const market = {
  market: "us", calendar: "Synthetic", timezone: "America/New_York", sessionDate: day,
  sessions: [{ date: day, open: sessionOpen, close: day + "T21:00:00Z", breakStart: null, breakEnd: null }],
  complete: true, asOf, fetchedAt: asOf, exposureGbp: 0, lastError: null, lastErrorAt: null,
};
const sectorNames = ["Technology", "Financials", "Communication", "Consumer", "Health", "Industrials", "Energy"];
const sectors = {
  market: "us", markets: [market],
  board: {
    market: "us", sessionDate: day, complete: true, asOf, fetchedAt: asOf, times,
    rankSessions: dailyDates.slice(-5), memberCount: 70, pricedCount: 70,
    exposureGbp: 1_000, exposureBasisGbp: 10_000,
    source: { universe: "Synthetic market", fund: "Synthetic fund", fundTicker: "SYNF", url: "", asOf: day, prices: "Synthetic" },
    groupings: [{ kind: "gics", groups: sectorNames.map((name, i) => ({
      key: String(i + 1), name, nameZh: null, weight: (8 - i) / 35, change: (i - 2) / 200,
      breadth: { up: 6, flat: 1, down: 3 }, memberCount: 10, leader: null,
      path: times.map((_, j) => (i - 2) * j / 6_600 + Math.sin(j / 3) * 0.001),
      ranks: [i + 1, i + 2, i + 1, i + 1, i + 1], streak: 0, exposureGbp: 0, subgroups: [], members: [],
    })) }],
  },
};
const health = {
  service: "trading_max-api", status: "ok", latestRunId: runId, artifactAgeSeconds: 900,
  queue: { queued: 0, running: 0, last_success_at: asOf }, worker: { healthy: true },
};
const researchShell = {
  status: { runId, overall: "fresh", artifacts: [] }, watchlistCategories: [],
  instruments: [{
    ticker, name: holdings[0].name, exchange: "NYSE", website: "", bloombergTicker: "", figi: "",
    categoryId: "", order: 0, status: "ready", lastRunId: runId, held: true, exposureGbp: 200,
    hasMarket: true, hasTechnical: true,
  }],
};
const quote = {
  id: "synthetic-quote", ticker, price: 101, currency: "USD", quoteUnit: "USD", exchange: "NYSE",
  timezone: "America/New_York", asOf, session: "regular", change: 1,
  changePct: 0.01, delayMinutes: 0, source: "synthetic", listing: "US:" + ticker, schedule: null,
};

const responses: Record<string, unknown> = {
  "/profile": { displayName: "Synthetic workspace", accountLabels: { A: "Synthetic Invest" } },
  "/health": health,
  "/health/details": { health, checkedAt: asOf, readiness: { status: "ready" }, jobs: [], errors: [] },
  "/refresh/attention": { checkedAt: asOf, issues: [] },
  "/dashboard/lens/overview": { ...summary, holdings },
  "/dashboard/lens/holdings-positions": { ...summary, holdings },
  "/dashboard/lens/holdings-lookthrough": { runId, lookthrough },
  "/dashboard/lens/analytics": { ...summary, nav },
  "/dashboard/lens/review": { ...summary, reviewAsOf: asOf },
  "/sectors": sectors,
  "/research/shell": researchShell,
  ["/research/" + ticker + "/lens/overview"]: {
    ticker, view: "overview", runId, generatedAt: asOf, dataRevision,
    context: { quote, assetType: "EQUITY", capabilities: [], datasets: [] },
    market: { spot: quote.price, currency: quote.currency }, timeline: [], events: [], models: [], alerts: [],
  },
  ["/research/" + ticker + "/prices"]: {
    ticker, currency: "USD", interval: "1d", asOf,
    points: dailyDates.map((date, i) => ({ date, close: 90 + i / 8 + Math.sin(i / 3) })),
  },
};

export function backendFixture(url: URL) {
  const path = url.pathname.slice("/api/backend".length);
  if (path !== "/dashboard/history") return responses[path];
  const range = portfolioRange(url.searchParams.get("range"));
  const prepared = prepareHistory(history, { range, scope: "total" });
  const page = url.searchParams.get("page");
  if (page !== null) return historyPage(prepared, Number(page));
  const openings = url.searchParams.getAll("opening");
  return openings.length ? { ...prepared.chart, openings: pnlsAt(prepared, openings) } : prepared.chart;
}
