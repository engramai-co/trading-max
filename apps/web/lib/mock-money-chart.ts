import type { CfdSummary, NavPoint } from "@/lib/types";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 0, 1);
const DAYS = 229;
const CFD_CUTOFF_INDEX = 95;
const RECENT_PNL_PULSE = [0, 80, 210, 340, 270, 170, 230, 110];

function dateAt(index: number) {
  return new Date(START_MS + index * DAY_MS).toISOString().slice(0, 10);
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function buildMockMoneyHistory() {
  let investPeak = Number.NEGATIVE_INFINITY;
  let isaPeak = Number.NEGATIVE_INFINITY;
  let totalPeak = Number.NEGATIVE_INFINITY;
  let householdPeak = Number.NEGATIVE_INFINITY;
  let cfdPeak = Number.NEGATIVE_INFINITY;

  return Array.from({ length: DAYS }, (_, index): NavPoint => {
    const investContributions = 3_500 + (index >= 28 ? 750 : 0) + (index >= 116 ? 600 : 0);
    const isaContributions = 16_000 + (index >= 52 ? 1_000 : 0) + (index >= 137 ? 900 : 0);
    const totalContributions = investContributions + isaContributions;
    const recentPulse = index >= DAYS - RECENT_PNL_PULSE.length
      ? RECENT_PNL_PULSE[index - (DAYS - RECENT_PNL_PULSE.length)]
      : 0;
    const investPnl = rounded(-280 + index * 5.4 + Math.sin(index / 8) * 250 + Math.sin(index / 2.8) * 55);
    const isaPnl = rounded(160 + index * 4.6 + Math.sin(index / 12) * 390 + Math.cos(index / 4.5) * 90 + recentPulse);
    const totalPnl = rounded(investPnl + isaPnl);
    const cfdProgress = Math.min(index / CFD_CUTOFF_INDEX, 1);
    const cfdPnl = rounded(-490 * cfdProgress + (index < CFD_CUTOFF_INDEX ? Math.sin(index / 5) * 35 : 0));
    const cfdContributions = 490;
    const cfdValue = rounded(Math.max(0, cfdContributions + cfdPnl));
    const householdPnl = rounded(totalPnl + cfdPnl);
    const householdValue = rounded(totalContributions + householdPnl);

    investPeak = Math.max(investPeak, investPnl);
    isaPeak = Math.max(isaPeak, isaPnl);
    totalPeak = Math.max(totalPeak, totalPnl);
    householdPeak = Math.max(householdPeak, householdPnl);
    cfdPeak = Math.max(cfdPeak, cfdPnl);

    return {
      cfd: cfdValue,
      cfdNetContributionsGbp: cfdContributions,
      cfdNetPnlGbp: cfdPnl,
      cfdNetRealisedPnlGbp: cfdPnl,
      cfdOvernightInterestGbp: rounded(-57 * cfdProgress),
      cfdPnlDrawdownGbp: rounded(Math.min(cfdPnl - cfdPeak, 0)),
      cfdProxyDrawdown: null,
      date: dateAt(index),
      flowStatus: "verified",
      household: householdValue,
      householdInternalTransferCounterflowGbp: 0,
      householdNetContributionsGbp: totalContributions,
      householdNetPnlGbp: householdPnl,
      householdPnlDrawdownGbp: rounded(Math.min(householdPnl - householdPeak, 0)),
      householdTransferMatchStatus: "verified",
      householdUnmatchedInternalTransferGbp: 0,
      intraday: false,
      invest: rounded(investContributions + investPnl),
      investDrawdown: null,
      investNetContributionsGbp: investContributions,
      investNetPnlGbp: investPnl,
      investPnlDrawdownGbp: rounded(Math.min(investPnl - investPeak, 0)),
      investTwr: investPnl / investContributions,
      isa: rounded(isaContributions + isaPnl),
      isaDrawdown: null,
      isaNetContributionsGbp: isaContributions,
      isaNetPnlGbp: isaPnl,
      isaPnlDrawdownGbp: rounded(Math.min(isaPnl - isaPeak, 0)),
      isaTwr: isaPnl / isaContributions,
      total: rounded(totalContributions + totalPnl),
      totalDrawdown: null,
      totalNetContributionsGbp: totalContributions,
      totalNetPnlGbp: totalPnl,
      totalPnlDrawdownGbp: rounded(Math.min(totalPnl - totalPeak, 0)),
      totalTwr: totalPnl / totalContributions,
    };
  });
}

export const mockMoneyNav = buildMockMoneyHistory();

const latest = mockMoneyNav.at(-1)!;

const MOCK_INTRADAY_DATES = [
  "2026-08-10",
  "2026-08-11",
  "2026-08-12",
  "2026-08-13",
  "2026-08-14",
  "2026-08-17",
];
const MOCK_INTRADAY_POINTS_PER_DAY = 102;

function bridgedRandomWalk(length: number, seed: number, stepSize: number) {
  let state = seed >>> 0;
  let cumulative = 0;
  const raw = Array.from({ length }, (_, index) => {
    if (index === 0) return 0;
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    const random = ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    cumulative += (random - 0.5) * stepSize;
    return cumulative;
  });
  const closingDrift = raw.at(-1) ?? 0;
  return raw.map((value, index) =>
    value - closingDrift * index / Math.max(length - 1, 1));
}

export const mockIntradayMoneyNav: NavPoint[] = MOCK_INTRADAY_DATES.flatMap(
  (date, sessionIndex) => {
    const dailyIndex = Math.round((Date.parse(`${date}T00:00:00Z`) - START_MS) / DAY_MS);
    const close = mockMoneyNav[dailyIndex] ?? latest;
    const prior = mockMoneyNav[Math.max(dailyIndex - 1, 0)] ?? close;
    const investStart = Number(prior.invest ?? close.invest ?? 0);
    const isaStart = Number(prior.isa ?? close.isa ?? 0);
    const investClose = Number(close.invest ?? investStart);
    const isaClose = Number(close.isa ?? isaStart);
    const investPath = bridgedRandomWalk(
      MOCK_INTRADAY_POINTS_PER_DAY,
      0xA17E_0000 + sessionIndex * 9_973,
      22 + sessionIndex * 1.7,
    );
    const isaPath = bridgedRandomWalk(
      MOCK_INTRADAY_POINTS_PER_DAY,
      0x15A0_0000 + sessionIndex * 12_983,
      35 + (sessionIndex % 3) * 4.5,
    );

    return Array.from({ length: MOCK_INTRADAY_POINTS_PER_DAY }, (_, pointIndex): NavPoint => {
      const progress = pointIndex / (MOCK_INTRADAY_POINTS_PER_DAY - 1);
      const minuteOfDay = 5 * 60 + pointIndex * 10;
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const invest = rounded(
        investStart + (investClose - investStart) * progress + investPath[pointIndex],
      );
      const isa = rounded(
        isaStart + (isaClose - isaStart) * progress + isaPath[pointIndex],
      );
      const total = rounded(invest + isa);

      return {
        ...close,
        date: `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
        flowStatus: "unverified",
        household: total,
        intraday: true,
        invest,
        isa,
        total,
      };
    });
  },
);

/** A retained week followed by a same-day outage/recovery window. */
export const mockOutageIntradayMoneyNav = mockIntradayMoneyNav.filter((point) => {
  if (!point.date.startsWith("2026-08-17")) return true;
  return [
    ["2026-08-17T07:10:00Z", "2026-08-17T08:00:00Z"],
    ["2026-08-17T08:40:00Z", "2026-08-17T09:10:00Z"],
    ["2026-08-17T09:50:00Z", "2026-08-17T10:10:00Z"],
  ].some(([start, end]) => point.date >= start && point.date <= end);
});

export const mockRetiredCfdStatus: CfdSummary = {
  accountStatus: "retired",
  asOf: "2026-04-06T18:15:00Z",
  closedPositions: 42,
  code: "C",
  coverageEndDate: "2026-04-06",
  coverageStartDate: "2026-01-01",
  endingValueGbp: 0,
  importedFiles: 1,
  isStale: true,
  lastImportedAt: "2026-04-06T18:20:00Z",
  latestEventAt: "2026-04-06T18:15:00Z",
  maxDrawdownGbp: -490,
  name: "CFD",
  navQuality: "realised_cash_equity_proxy",
  netExternalFlowsGbp: 490,
  overnightChargesGbp: -57,
  pnlSharpeProxy: null,
  profile: "mock-retired-cfd",
  realizedPnlGbp: -490,
  reconciliationGapGbp: 0,
  reconciliationStatus: "verified",
  source: "synthetic-mock",
  staleAfterDays: 0,
  staleRemindersEnabled: false,
  trueNavAvailable: false,
  warning: "Synthetic retired CFD proxy; no broker NAV or freshness reminder.",
};
