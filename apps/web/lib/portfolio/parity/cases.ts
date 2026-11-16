import type { BenchmarkPricePoint, NavPoint } from "@/lib/types";
import { numeric } from "@/lib/numeric";
import { benchmarkComparison } from "../benchmark-comparison";
import { deepestDrawdown, drawdownEpisodes } from "../drawdown-episodes";
import {
  PORTFOLIO_RANGES, historyDay, historyDisplayInterval, historyWindow, portfolioRange,
  selectPortfolioHistory, tradingDay,
} from "../history";
import { drawdowns, minimumObserved } from "../math";
import { portfolioMoney } from "../money";
import { difference, inRange, navNumber, observedNav, periodReturn, type Scope } from "../nav";
import { encodeTimeline, exactInstant, pnlsAt, prepareHistory, type HistoryInput } from "../prepared";
import { returnPeriods } from "../return-periods";

type Case = { function: string; name: string; input: unknown; output: unknown };

function point(date: string, intraday = false, value: number | null = 100, fields: Partial<NavPoint> = {}): NavPoint {
  return {
    date, intraday, flowStatus: intraday ? "unverified" : "daily_official",
    invest: value, isa: value, total: value, household: value, cfd: intraday ? null : value,
    investTwr: null, isaTwr: null, totalTwr: null,
    investDrawdown: null, isaDrawdown: null, totalDrawdown: null, cfdProxyDrawdown: null,
    ...fields,
  };
}
const baseDay = "2026-09-04";
const at = (time: string) => baseDay + "T" + time + "Z";
const timeSteps = (start: string, count: number) =>
  Array.from({ length: count }, (_, index) => new Date(Date.parse(start) + index * 600_000).toISOString());
const september = (count: number) => timeSteps("2026-09-03T23:00Z", count);

function fullHistory(result: ReturnType<typeof selectPortfolioHistory>) {
  return { ...result, timeline: encodeTimeline(result.timeline, new Map(result.points.map((_, index) => [index, index]))) };
}

export function parityCases() {
  const cases: Case[] = [];
  const add = (fn: string, name: string, input: unknown, output: unknown) =>
    cases.push({ function: fn, name, input, output: output === undefined ? { $js: "undefined" } : output });
  const history = (name: string, selection: Parameters<typeof selectPortfolioHistory>[0]) =>
    add("select_portfolio_history", name, selection, fullHistory(selectPortfolioHistory(selection)));
  const prepare = (name: string, input: HistoryInput, selection: Parameters<typeof prepareHistory>[1]) => {
    const { chart, history, money } = prepareHistory(input, selection);
    const { runId, dataRevision, sourceCount } = chart;
    add("prepare_history", name, [input, selection], { runId, dataRevision, sourceCount, history: fullHistory(history), money });
  };
  const money = (name: string, points: NavPoint[], scope: Scope = "total") =>
    add("portfolio_money", name, [points, scope], portfolioMoney(points, scope));

  // Accounting and source scenarios from history.test.ts. Display-only stroke
  // samples are still tested in the web suite; raw coverage stays in parity.
  const daily = [point("2026-08-01"), point("2026-09-01"), point(baseDay)];
  const intraday = [point(at("13:30:00"), true), point(at("13:40:00"), true, 120)];
  const input = { daily, intraday, scope: "total" as const, asOf: at("20:00:00") };
  for (const range of PORTFOLIO_RANGES) history("source by range " + range, { ...input, range });
  history("unreconciled cash flows throughout", { ...input, range: "1D", requireCashFlows: true });
  const verified = intraday.map((row) => ({ ...row, totalNetContributionsGbp: 100 }));
  history("only earlier flow is verified", { ...input, intraday: [verified[0], intraday[1]], range: "1D", requireCashFlows: true });
  history("only later flow is verified", { ...input, intraday: [intraday[0], verified[1]], range: "1D", requireCashFlows: true });
  history("all flows verified", { ...input, intraday: verified, range: "1D", requireCashFlows: true });
  history("latest CFD conversion missing", { ...input, daily: [daily[0], { ...daily[2], cfd: null, household: null }], range: "3M", scope: "household" });
  history("CFD field omitted by API", { ...input, daily: [], range: "3M", scope: "household" });
  history("CFD daily only", { ...input, range: "3M", scope: "cfd" });
  history("CFD proxy without verified flow", { ...input, range: "3M", scope: "household" });
  history("explicit zero CFD proxy", {
    ...input, range: "1D", scope: "household", intraday: verified,
    daily: [point(baseDay, false, 100, { cfd: 0, totalNetContributionsGbp: 100, householdNetContributionsGbp: 80 })],
  });
  for (const range of ["3M", "6M"] as const) history("daily-only prefix " + range, { ...input, intraday: [], range });
  history("daily display retains intraday extrema", {
    ...input, daily: [], range: "1Y", intraday: [100, 70, 110].map((v, i) => point(at(`1${i}:00`), true, v, { totalNetContributionsGbp: 100 })),
  });
  history("outage estimates remain records", {
    ...input, range: "6M", intraday: [
      point("2026-08-10T12:00Z", true, 101, { valuationSource: "broker" }),
      point("2026-09-01T12:00Z", true, 999, { valuationSource: "reconstructed" }), ...intraday,
    ],
  });
  const pending = [100, 110, 999].map((v, i) => point(at(`13:${i + 2}0`), true, v, { totalNetContributionsGbp: i === 2 ? null : 80 }));
  for (const range of ["3M", "6M", "YTD", "1Y"] as const) {
    history("common cash-flow cutoff " + range, { ...input, range, intraday: pending, requireCashFlows: true });
  }
  history("as-of date keeps stale history outside five weekdays", { ...input, range: "1W", intraday: [point("2026-07-01T12:00Z", true)] });
  history("Friday on Sunday", { ...input, range: "1D", asOf: "2026-09-06T12:00Z" });
  history("Monday has no Friday fallback", { ...input, range: "1D", asOf: "2026-09-07T12:00Z" });
  history("single observed zero", { ...input, range: "1D", intraday: [point(at("12:00"), true, 0)] });
  const dense = september(144).map((date, index) => point(date, true, 100 + index, {
    valuationSource: index === 91 || index >= 94 ? "broker" : "reconstructed",
  }));
  for (const range of ["1D", "1W", "1M", "3M", "6M"] as const) {
    history("dense source transitions " + range, { ...input, daily: [], range, intraday: dense, asOf: dense.at(-1)!.date });
  }
  history("stale trailing buckets", { ...input, range: "1D", intraday: dense.slice(0, -3), asOf: dense.at(-1)!.date });
  history("one missing ten-minute slot", { ...input, range: "1D", intraday: dense.filter((_, index) => index !== 91), asOf: dense.at(-1)!.date });
  history("weekend rows retained outside chart", { ...input, range: "1M", intraday: [point("2026-08-30T12:00Z", true, 90), ...intraday] });
  history("earlier adjacent daily values are genuine", {
    ...input, range: "6M", asOf: "2026-09-03T12:00Z", daily: [point("2026-09-01"), point("2026-09-02")], intraday: [point("2026-09-03T12:00Z", true)],
  });
  const estimates = intraday.map((row) => ({ ...row, valuationSource: "reconstructed" as const }));
  history("estimated-only selected window", { ...input, range: "1D", intraday: estimates });
  history("older broker outside estimated-only window", { ...input, range: "1D", intraday: [point("2026-09-01T12:00Z", true, 100, { valuationSource: "broker" }), ...estimates] });
  const broker = { ...intraday[0], valuationSource: "broker" as const };
  const model = { ...broker, date: at("13:30:00.000"), total: 999, valuationSource: "reconstructed" as const };
  const offsetModel = { ...model, date: baseDay + "T14:30:00+01:00" };
  history("broker first on instant tie", { ...input, range: "1D", intraday: [broker, offsetModel] });
  history("broker last on instant tie", { ...input, range: "1D", intraday: [offsetModel, broker] });
  history("first model and last broker on their stable ties", { ...input, range: "1D", intraday: [
    model, { ...model, total: 111 }, { ...model, date: at("14:00"), valuationSource: "broker", total: 112 },
    { ...model, date: at("14:00"), valuationSource: "broker", total: 113 },
  ] });
  history("invalid dates and scope values", { ...input, range: "1W", intraday: [
    intraday[1], point("invalid", true), intraday[0], point(at("13:50"), true, null),
  ] });
  history("empty history", { range: "3M", scope: "total" });
  history("empty history with valid year boundary", { range: "YTD", scope: "total", asOf: "2026-01-01" });

  // Calendar edges: the windows retain rows through both DST changes, and the
  // timeline folds only the defined weekend hours. No holiday calendar is used.
  for (const [label, stamps] of [
    ["spring DST", ["2026-03-28T00:50Z", "2026-03-28T01:00Z", "2026-03-29T00:50Z", "2026-03-29T01:10Z", "2026-03-29T20:50Z", "2026-03-29T21:05Z", "2026-03-29T23:15Z", "2026-03-30T01:52Z"]],
    ["autumn DST", ["2026-10-23T23:50Z", "2026-10-24T01:00Z", "2026-10-25T01:30:00+01:00", "2026-10-25T01:30:00+00:00", "2026-10-25T21:50Z", "2026-10-25T22:05Z", "2026-10-26T00:15Z"]],
  ] as const) {
    for (const range of ["1W", "1M", "3M"] as const) {
      history(label + " " + range, { range, scope: "total", intraday: stamps.map((date, i) => point(date, true, 100 + i)) });
    }
  }
  history("bank holiday is a potential weekday bucket", { range: "1W", scope: "total", intraday: [
    point("2026-04-02T23:00Z", true, 100), point("2026-04-07T08:10Z", true, 101),
  ] });
  history("same bucket latest row; absent provenance differs from null", { range: "1D", scope: "total", intraday: [
    point(at("09:01"), true, 99), point(at("09:07"), true, 100), point(at("09:10"), true, 101, { valuationSource: null }),
  ] });

  const estimateMoney = [100, 100, 130, 101, 131, 99, 102].map((v, i) =>
    point(at(i < 6 ? `09:${String(i * 10).padStart(2, "0")}` : "10:00"), true, v, {
      valuationSource: i === 2 || i === 4 ? "reconstructed" : "broker", totalNetContributionsGbp: 100,
    }));
  history("model qualifies money statistics", { ...input, range: "1D", intraday: estimateMoney, asOf: estimateMoney.at(-1)!.date });
  money("model qualifies money statistics", estimateMoney);
  const spike = [100, 130, 150, 112].map((v, i) => point(at(`09:${i * 10 + 10}`), true, v, {
    valuationSource: i === 1 ? "reconstructed" : "broker", totalNetContributionsGbp: i < 1 ? 100 : 110,
    investModelValueGbp: i === 2 ? 105 : undefined,
  }));
  history("spike, reconstruction and flow anchors", { ...input, range: "1D", intraday: spike, asOf: spike.at(-1)!.date });
  money("spike with external flow", spike);
  const amounts = [[100, 100], [180, 180], [200, 180], [150, 130], [140, 130]];
  for (const isIntraday of [true, false]) {
    money(`deposit and withdrawal, intraday=${isIntraday}`, amounts.map(([v, flow], index) =>
      point(`2026-01-0${index + 2}`, isIntraday, v, { totalNetContributionsGbp: flow })));
  }
  money("missing flows cannot become value changes", amounts.map(([v], index) =>
    point(`2026-01-0${index + 2}`, true, v, { totalNetContributionsGbp: null })));
  money("sparse interior flow keeps later endpoint P&L", amounts.map(([v, flow], index) =>
    point(`2026-01-0${index + 2}`, true, v, { totalNetContributionsGbp: index === 2 ? null : flow })));
  for (const [name, values, estimated] of [
    ["rising and flat", [100, 110, 110], []], ["tied peak", [100, 120, 120, 80, 119, 120, 130], []],
    ["not recovered", [100, 120, 80, 119], []], ["estimated peak and trough", [100, 120, 80, 125], [1, 2]],
    ["zero opening", [0, 30], []], ["negative opening", [-100, 30], []],
    ["single observation", [100], []], ["empty", [], []],
  ] as const) {
    money(name, (values as readonly number[]).map((v, i) => point(`2026-01-0${i + 1}`, false, v, {
      totalNetContributionsGbp: 100, valuationSource: (estimated as readonly number[]).includes(i) ? "reconstructed" : "broker",
    })));
  }

  const transfers = [
    point("2026-09-02", false, 180, { invest: 100, isa: 80, cfd: 20, household: 200,
      totalNetContributionsGbp: 160, investNetContributionsGbp: 90, isaNetContributionsGbp: 70, cfdNetContributionsGbp: 10, householdNetContributionsGbp: 170 }),
    point("2026-09-03", false, 180, { invest: 80, isa: 100, cfd: 20, household: 200,
      totalNetContributionsGbp: 160, investNetContributionsGbp: 70, isaNetContributionsGbp: 90, cfdNetContributionsGbp: 10,
      householdNetContributionsGbp: 170, householdInternalTransferCounterflowGbp: 20, householdTransferMatchStatus: "verified" }),
  ];
  const longDaily = [point("2024-08-30", false, 80, { totalNetContributionsGbp: 80 }), point("2025-09-04", false, 150, { totalNetContributionsGbp: 150 }),
    point("2026-01-02", false, 160, { totalNetContributionsGbp: 150 }), ...transfers];
  const exactRows = timeSteps(at("09:00"), 24).map((date, i) => point(date, true, i === 13 ? 75 : 200 + i, {
    invest: 80 + i, isa: 120, valuationSource: i > 9 && i < 16 ? "reconstructed" : "broker",
    investNetContributionsGbp: 70, isaNetContributionsGbp: 90,
    totalNetContributionsGbp: i === 23 ? null : 160 + (i > 17 ? 20 : 0),
  }));
  const preparedInput: HistoryInput = { runId: "synthetic-a", dataRevision: "data-a", brokerAsOf: exactRows.at(-1)!.date, nav: longDaily, intradayNav: exactRows };
  for (const scope of ["invest", "isa", "total", "household", "cfd"] as const) {
    for (const range of PORTFOLIO_RANGES) prepare(`${scope} / ${range}`, preparedInput, { scope, range });
    money("internal transfer " + scope, transfers, scope);
  }
  prepare("daily display retains full-resolution drawdown and exact ending", {
    ...preparedInput, nav: [], intradayNav: [100, 70, 110].map((v, i) => point(at(`1${i}:00`), true, v, { totalNetContributionsGbp: 100 })),
  }, { range: "1Y", scope: "total" });
  for (const opening of [0, -100]) {
    prepare("suppress unavailable percentages " + opening, {
      ...preparedInput, nav: [], intradayNav: [opening, 30].map((v, i) => point(at(`1${i}:00`), true, v, { totalNetContributionsGbp: 100 })),
    }, { range: "1D", scope: "total" });
  }
  const outage = ["2026-10-12T12:00Z", "2026-10-15T12:00Z", "2026-10-23T12:00Z", "2026-10-27T12:00Z", "2026-10-28T12:00Z"].map((date, i) =>
    point(date, true, 100 + [0, 9, -20, -3, 11][i], { totalNetContributionsGbp: 100, valuationSource: i === 0 || i === 4 ? "broker" : "reconstructed" }));
  prepare("two-week reconstruction and recovered drawdown", {
    ...preparedInput, nav: [], intradayNav: outage, brokerAsOf: outage.at(-1)!.date,
  }, { range: "1M", scope: "total" });
  prepare("absent optional lists", { runId: "synthetic-empty", dataRevision: "data-empty", brokerAsOf: baseDay }, { range: "ALL", scope: "total" });

  const openingsRows = timeSteps("2026-10-29T00:00:00Z", 37)
    .map((date, step) => point(date, true, 1000 + step, { totalNetContributionsGbp: 1000 }));
  const openingsInput = { runId: "synthetic-opening", dataRevision: "data-opening", brokerAsOf: openingsRows.at(-1)!.date, intradayNav: openingsRows };
  const selection = { range: "1W" as const, scope: "total" as const };
  const instants = ["2026-10-29T00:10:00Z", "2026-10-29T00:12:00Z", "2026-10-29T01:10:00+01:00",
    "2026-10-28T19:10:00-05:00", "2026-10-29T00:05:00Z", "2026-10-29T00:04:59.999Z", "invalid", "2026-10-29T06:00:00.001Z"];
  add("pnls_at", "exact observations independent of chart buckets", [openingsInput, selection, instants],
    pnlsAt(prepareHistory(openingsInput, selection), instants));

  for (const stamp of [
    "2026-11-02T08:10:00Z", "2026-11-02T08:10:00+00:00", "2026-11-02T09:10:00+01:00",
    "2026-11-02T03:10:00-05:00", "2026-11-02T08:10:00.123456Z", "2028-02-29T00:00:00Z",
    "2026-11-02T08:10:00", "2026-02-30T08:10:00Z", "2026-02-29T08:10:00Z", "2026-11-31T08:10:00Z",
    "2026-11-02T24:00:00Z", "2026-11-02T23:59:60Z", "2026-11-02T08:10:00+25:00", "2026-11-02T08:10:00+0100",
    "2026-11-02T08:10Z", "2026-11-02 08:10:00Z", "2026-11-02", "yesterday", "1969-12-31T23:59:59.999999Z",
  ]) add("exact_instant", stamp, [stamp], exactInstant(stamp));
  for (const stamp of ["2026-11-07T10:00:00Z", "2026-11-02T23:30:00Z", "2026-07-05T23:30:00Z", null, "not a date"]) {
    add("trading_day", String(stamp), [stamp], tradingDay(stamp));
  }
  for (const stamp of ["2026-03-29T22:59:59.999Z", "2026-03-29T23:00Z", "2026-10-25T23:00Z"]) {
    add("history_day", stamp, [stamp], historyDay(stamp));
  }
  for (const end of ["2026-01-01", "2026-01-05", "2026-01-20", "2026-03-31", "2026-06-30", "2026-09-18"]) {
    add("history_display_interval", end, ["YTD", end], historyDisplayInterval("YTD", end));
  }
  for (const [value, fallback] of [["1M", "1D"], [null, "1D"], ["2Y", "1D"], [null, "3M"]] as const) {
    add("portfolio_range", `${value} / ${fallback}`, [value, fallback], portfolioRange(value, fallback));
  }
  for (const [range, end] of [["1M", "2024-03-31"], ["1M", "2024-05-31"], ["1Y", "2024-02-29"], ["2Y", "2024-02-29"], ["ALL", "2026-09-06"]] as const) {
    add("history_window", `${range} / ${end}`, [range, end], historyWindow(range, end));
  }

  const returnPoints = ["2024-12-31", "2025-01-01", "2025-03-01", "invalid"].map((date) => ({ date }));
  for (const range of [...PORTFOLIO_RANGES, "2Y"] as const) {
    add("in_range", range, [returnPoints, range], inRange(returnPoints, range));
  }
  const isoBoundary = ["2026-02-30T12:00:00Z", "2026-03-01T12:00:00Z", "2026-03-02T24:00:00Z",
    "2026-03-02T24:00:00.0001Z", "2026-03-01T12:00:00.000999Z"].map((date) => ({ date }));
  add("in_range", "ISO normalization and stable sub-millisecond ties", [isoBoundary, "ALL"], inRange(isoBoundary, "ALL"));
  const dailyTwr = (date: string, totalTwr: number | null, intraday = false) => ({ date, totalTwr, intraday }) as NavPoint;
  const observed = [dailyTwr("2026-01-02", null), dailyTwr("2026-01-05", 0), dailyTwr("2026-01-06", null),
    dailyTwr("2026-01-07", 0.1), dailyTwr("2026-01-08", null), dailyTwr("2026-01-09", 0.2, true)];
  add("observed_nav", "trim boundaries and exclude intraday, keep interior gap", [observed, "total", "Twr"], observedNav(observed, "total", "Twr"));
  const twr = (name: string, points: NavPoint[], scope: Scope, asOf?: string) => {
    const input = asOf === undefined ? [points, scope] : [points, scope, asOf];
    add("return_periods", name, input, returnPeriods(points, scope, asOf));
  };
  twr("compound contiguous complete months", [
    dailyTwr("2025-12-31", 0), dailyTwr("2026-01-30", 0.2), dailyTwr("2026-02-27", 0.08), dailyTwr("2026-03-12", 0.134),
  ], "total", "2026-03-12");
  twr("missing or invalid month", [
    dailyTwr("2025-12-31", 0), dailyTwr("2026-01-30", 0.03), dailyTwr("2026-02-27", null),
    dailyTwr("2026-03-31", 0.07), dailyTwr("2026-04-30", 0.08), dailyTwr("2026-05-29", 0.1),
  ], "total", "2026-06-02");
  twr("scope and leap month boundary, sorted with intraday excluded", [
    dailyTwr("2024-03-31", null, true), { ...dailyTwr("2024-03-28", null), isaTwr: 0.4 },
    { ...dailyTwr("2024-02-29", null), isaTwr: 0.3 }, { ...dailyTwr("2024-01-31", null), isaTwr: 0.1 },
    { ...dailyTwr("2023-12-29", null), isaTwr: 0.12 },
  ], "isa", "2024-03-31");
  twr("whole calendar year", Array.from({ length: 13 }, (_, i) =>
    dailyTwr(new Date(Date.UTC(2026, i, 0)).toISOString().slice(0, 10), i * 0.02)), "total");
  twr("empty", [], "total");
  twr("single point", [dailyTwr("2026-01-30", 0.01)], "total");

  const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const nav = dates.map((date, i) => ({ date, totalTwr: i === 2 ? null : 0.01 * i } as NavPoint));
  const prices = (entries: number[][]) => entries.map(([i, close]) => ({ date: dates[i], close }));
  const comparison = (name: string, series: Record<string, BenchmarkPricePoint[]> | undefined, names: string[], points = nav) =>
    add("benchmark_comparison", name, [points, "total", series ?? null, names], benchmarkComparison(points, "total", series, names));
  comparison("shared usable dates", { VOO: prices([[1, 50], [2, 75], [3, 60]]) }, ["VOO"]);
  comparison("only one overlap", { VOO: prices([[1, 50], [2, 75], [3, 0]]) }, ["VOO"]);
  comparison("one missing benchmark", { VOO: prices([[0, 50], [3, 60]]) }, ["VOO", "QQQ"]);
  comparison("all share two dates", {
    VOO: prices([[0, 50], [1, 50], [3, 60]]), QQQ: prices([[1, 100], [3, 90]]), VT: prices([[1, 30], [3, 31]]),
  }, ["VOO", "QQQ", "VT"]);
  comparison("usable individually but no two dates in common", { VOO: prices([[0, 50], [1, 60]]), QQQ: prices([[1, 100], [3, 90]]) }, ["VOO", "QQQ"]);
  comparison("legacy close fallback and last duplicate wins", { VOO: [
    { date: dates[0], price: 30 } as unknown as BenchmarkPricePoint, ...prices([[0, 40]]),
    { date: dates[3], close: null, price: 65 } as unknown as BenchmarkPricePoint,
  ] }, ["VOO"]);
  comparison("no requested benchmark or points", undefined, [], []);
  comparison("duplicate intraday dates count as shared", { VOO: prices([[0, 50]]) }, ["VOO"], [
    dailyTwr(dates[0] + "T10:00Z", 0), dailyTwr(dates[0] + "T12:00Z", 0.1),
  ]);

  const drawdown = (name: string, values: Array<number | null>, compounded = false) =>
    add("drawdowns", name, [values, compounded], drawdowns(values, compounded));
  drawdown("cash adjusted peaks and gaps", [100, 150, null, 120, 170, 90]);
  drawdown("compounded rates and gaps", [0, 0.2, 0.08, null, 0.32], true);
  drawdown("unavailable high until above minus one", [-2, -1, -0.7, -1.5, -0.7], true);
  drawdown("non-finite values and arithmetic overflow", [null, Number.NaN, 1e308, -1e308, Infinity, -Infinity, 1]);
  drawdown("signed zero extremum", [-0, 0, -0]);
  for (const values of [[null, null], [Number.NaN, Infinity, -Infinity, 0, -3], [0, -0]]) {
    add("minimum_observed", String(values), [values], minimumObserved(values));
  }
  for (const [name, values] of [
    ["last tied peak and recovery", [0, 0, -0.1, -0.22, -0.04, 0, 0, -0.1]],
    ["interruption", [0, -0.22, null, -0.3, 0, -0.2]],
    ["first deepest tie and non-finite gap", [0, -0.3, -0.3, Infinity, 0, -0.3]],
    ["no episode", [-0.3, null, 0]],
  ] satisfies [string, (number | null)[]][]) {
    add("drawdown_episodes", name, [values], drawdownEpisodes(values));
    add("deepest_drawdown", name, [values], deepestDrawdown(values));
  }
  for (const [name, value] of Object.entries({
    blank: " ", null: null, false: false, nan: NaN, infinity: Infinity, negativeZero: -0,
    bom: "\ufeff 4.25", invalidUnderscores: "1_000", invalidRadix: "-0x10", validRadix: "0x10",
    invalidWhitespace: "\u0085", largeDecimal: "1e309", tinyDecimal: "5e-324", exponent: ".5e+2", roundedInteger: 9007199254740993,
  })) add("numeric", name, [value], numeric(value));
  for (const [start, end] of [[0.2, 0.08], [-1, 0.1], [null, 0], ["0.2", "0.08"], [-0.9999999999999999, 1e308]]) {
    add("period_return", JSON.stringify([start, end]), [start, end], periodReturn(start, end));
    add("difference", JSON.stringify([start, end]), [start, end], difference(start, end));
  }
  add("nav_number", "numeric string and absent data", [{ date: baseDay, total: "101.2" }, "total"],
    navNumber({ date: baseDay, total: "101.2" } as unknown as NavPoint, "total"));
  return cases;
}
