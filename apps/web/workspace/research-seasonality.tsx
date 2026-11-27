"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { formatCalendarDate, formatDate } from "@/ui/formatters";
import { Plot } from "./charts";
import { number, object, objects, percent, str, tone } from "@/workspace/data";
import { cn } from "@/lib/utils";
import { numeric } from "@/lib/numeric";
import { LINE_DASH_PATTERNS, type ChartReadout, type LineDash, type ReadingKey } from "./chart-readout";
import { Facts, Panel, Segments, useCopy } from "./foundation";
import { minus } from "./reading-figures";
import { readingTone, signedPercent } from "./reading-format";
import { researchPriceQuery } from "./research-queries";
import { useRouteState } from "./route-state";
import { MultiPicker, SelectPicker } from "./picker";

/** Fewer observations than this make a month's average unreliable. */
const THIN_SAMPLE = 5;

/**
 * The latest selected year leads in cobalt; earlier years use ink and grey, solid then dashed.
 * A benchmark path is thin and broken in its year's colour, except that the latest year's benchmark
 * uses the neutral comparison colour: cobalt belongs to the instrument's own line. Ink and grey
 * repeat across years, so each benchmark year also takes its own pattern (dotted, dash-dot,
 * dash-dot-dot): no two benchmark paths, and no benchmark and year path, draw alike in either scheme.
 * Legend, hover dot and reading key share the stroke.
 */
const YEAR_LINES = [
  { colour: "brand", dashed: false, width: 2 },
  { colour: "text", dashed: false, width: 1.3 },
  { colour: "axis", dashed: false, width: 1.3 },
  { colour: "text", dashed: true, width: 1.3 },
  { colour: "axis", dashed: true, width: 1.3 },
] as const satisfies ReadonlyArray<{ colour: keyof ChartColours; dashed: boolean; width: number }>;
const BENCHMARK_DASHES = ["dot", "dot", "dash-dot", "dash-dot", "dash-dot-dot"] as const satisfies ReadonlyArray<LineDash>;
export function seasonStroke(colours: ChartColours, year: number, benchmark = false) {
  const index = Math.min(year, YEAR_LINES.length - 1);
  const line = YEAR_LINES[index];
  const colour = benchmark && line.colour === "brand" ? colours.comparison : colours[line.colour];
  const dash: LineDash | undefined = benchmark ? BENCHMARK_DASHES[index] : undefined;
  return {
    colour,
    width: benchmark ? 1.2 : line.width,
    type: dash ? LINE_DASH_PATTERNS[dash].chart : line.dashed ? [6, 4] : ("solid" as const),
    dash,
  };
}
/** A year's change on a calendar day: its own close, or the close before a weekend or holiday. */
export function changeOnDay(points: Array<[number, number | null]>, day: number) {
  let found: number | null = null;
  for (const [at, value] of points) {
    if (at > day) break;
    if (value != null && day - at <= 4) found = value;
  }
  return found;
}

export function Seasonality({ data, revision }: { data: ResearchLensSnapshot; revision?: string | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const { params, update } = useRouteState("push");
  const [measure, setMeasure] = useState("meanReturn"),
    [month, setMonth] = useState(1);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const benchmarkSymbol = params.get("seasonBenchmark") ?? "none";
  const benchmark = useQuery({
    ...researchPriceQuery(benchmarkSymbol, revision ?? data.runId),
    enabled: benchmarkSymbol !== "none",
    retry: false,
  });
  const source = object(data.fundamentals ?? data.technical),
    coverage = object(source.seasonalityCoverage);
  const matrix = objects(source.seasonalityMatrix);
  const cellIndex = new Map(matrix.map((r) => [`${r.year}-${r.month}`, r]));
  const yearPaths = object(source.yearPaths);
  const years = [...new Set(matrix.map((r) => Number(r.year)))].toSorted(
    (a, b) => b - a,
  );
  const window = ["5", "10", "20", "all", "custom"].includes(
    params.get("seasonYears") ?? "",
  )
    ? params.get("seasonYears")!
    : "10";
  const visibleYears =
    window === "custom"
      ? years.filter(
          (year) =>
            year >= Number(params.get("seasonFrom") ?? years.at(-1)) &&
            year <= Number(params.get("seasonTo") ?? years[0]),
        )
      : window === "all"
        ? years
        : years.filter((year) => year > (years[0] ?? 0) - Number(window));
  const selectedMatrix = matrix.filter((r) =>
    visibleYears.includes(Number(r.year)),
  );
  const sampleMonths = selectedMatrix
    .filter((r) => numeric(r.return) != null)
    .map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`)
    .sort();
  const rows = matrix.length
    ? Array.from({ length: 12 }, (_, i) => {
        const values = selectedMatrix
          .filter((r) => r.month === i + 1)
          .map((r) => numeric(r.return))
          .filter((n): n is number => n != null)
          .sort((a, b) => a - b);
        return {
          month: i + 1,
          meanReturn: values.length
            ? values.reduce((s, n) => s + n, 0) / values.length
            : null,
          medianReturn: values.length
            ? (values[Math.floor((values.length - 1) / 2)] +
                values[Math.floor(values.length / 2)]) /
              2
            : null,
          hitRate: values.length
            ? values.filter((n) => n > 0).length / values.length
            : null,
          observations: values.length,
          best: values.at(-1),
          worst: values[0],
        };
      })
    : objects(source.seasonality).filter((r) => numeric(r.month) != null);
  if (!rows.length) return null;
  const selected = rows.find((r) => r.month === month) ?? rows[0];
  const months = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(t("zh-CN", "en"), {
      month: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2000, i, 1))),
  );
  const availablePaths = Object.keys(yearPaths).toSorted().toReversed(),
    paths = chosen ?? availablePaths.slice(0, 3);
  const comparable = benchmark.data?.currency === data.context?.quote.currency;
  const benchmarkPaths: Record<string, Record<string, unknown>[]> = {};
  if (comparable) {
    const points = (benchmark.data?.points ?? []).toSorted((a, b) =>
      a.date.localeCompare(b.date),
    );
    for (const year of paths) {
      const previous = points
        .filter((p) => Number(p.date.slice(0, 4)) === Number(year) - 1)
        .at(-1);
      if (previous && previous.close > 0)
        benchmarkPaths[year] = points
          .filter((p) => p.date.startsWith(year))
          .map((p) => ({
            date: p.date.slice(0, 10),
            day: p.date.slice(5, 10),
            return: p.close / previous.close - 1,
          }));
    }
  }
  const chartPaths = {
    ...Object.fromEntries(
      paths.map((year) => [year, objects(yearPaths[year])]),
    ),
    ...Object.fromEntries(
      Object.entries(benchmarkPaths).map(([year, points]) => [
        `${year} · ${benchmarkSymbol}`,
        points,
      ]),
    ),
  };
  const dayNumber = (day: string) =>
    (Date.parse("2000-" + day + "T00:00:00Z") -
      Date.parse("2000-01-01T00:00:00Z")) /
    86400000;
  // The selected years in their chosen order (latest first), then any benchmark paths.
  const pathLines = [
    ...paths.filter((year) => yearPaths[year] != null).map((year, index) => ({ name: year, year: index, benchmark: false, points: objects(yearPaths[year]) })),
    ...Object.entries(benchmarkPaths).map(([year, points]) => ({
      name: year + " · " + benchmarkSymbol, year: Math.max(0, paths.indexOf(year)), benchmark: true, points,
    })),
  ].map((line) => ({
    ...line,
    series: line.points.map((p): [number, number | null] => [dayNumber(str(p.day)), numeric(p.return)])
      .sort((a, b) => a[0] - b[0]),
  }));
  const key = (index: number): ReadingKey => {
    const line = pathLines[index];
    const stroke = seasonStroke(colours, line.year, line.benchmark);
    // A benchmark path keys its own pattern, an earlier year dashed; the key draws the same stroke.
    return stroke.dash ? { colour: stroke.colour, dash: stroke.dash } : { colour: stroke.colour, dashed: stroke.type !== "solid" || undefined };
  };
  const dayLabel = (day: number) => formatDate(new Date(Date.UTC(2000, 0, 1 + day)), locale, { month: "short", day: "numeric", timeZone: "UTC" });
  // Every year reads at the same calendar day, so the reading opens wherever the pointer or keys rest.
  const seasonReadout: ChartReadout = {
    positions: [...new Set(pathLines.flatMap((line) => line.series.map(([day]) => day)))].toSorted((a, b) => a - b),
    read: (day) => {
      const values = pathLines.map((line) => changeOnDay(line.series, day));
      if (!pathLines.length || values.every((value) => value == null)) return null;
      const shown = (value: number | null) => value == null ? "—" : signedPercent(value);
      return {
        time: dayLabel(day),
        primary: { label: pathLines[0].name, key: key(0), value: shown(values[0]), tone: readingTone(values[0], 4) },
        groups: [pathLines.slice(1).flatMap((line, offset) => values[offset + 1] == null ? []
          : [{ label: line.name, value: shown(values[offset + 1]), key: key(offset + 1) }])],
      };
    },
    latest: pathLines[0] ? minus(percent(pathLines[0].series.findLast(([, value]) => value != null)?.[1], true, 2)) : "—",
    marks: (day) => pathLines.flatMap((line, index) => {
      const value = changeOnDay(line.series, day);
      return value == null ? [] : [{ value, colour: key(index).colour }];
    }),
  };
  return (
    <>
      <Panel
        title={t("月度季节性", "Monthly seasonality")}
        help={t(
          "每格是该月的涨跌。选择年份会同时重算均值、中位数和上涨比例。",
          "Each cell is that month's return. Selecting years recalculates the mean, median and share of rising months.",
        )}
        helpBasis={t(
          "拆股及分红调整后的价格。只计完整交易月份，当月未结束和缺少月末收盘的月份不入样本。",
          "Split and dividend adjusted prices. Only completed exchange months count; unfinished months and missing month-end closes are excluded.",
        )}
        action={
          matrix.length ? (
            <Segments
              label={t("历史范围", "Historical window")}
              value={window}
              onChange={(v) => update({ seasonYears: v })}
              options={[
                { value: "5", label: t("5 年", "5 years") },
                { value: "10", label: t("10 年", "10 years") },
                { value: "20", label: t("20 年", "20 years") },
                { value: "all", label: t("全部", "All") },
                { value: "custom", label: t("自定义", "Custom") },
              ]}
            />
          ) : undefined
        }
      >
        {matrix.length > 0 && window === "custom" && (
          <div className="mb-mx-md flex flex-wrap items-center gap-mx-md">
            <SelectPicker
              style={{ width: 140 }}
              label={t("起始年份", "From year")}
              value={params.get("seasonFrom") ?? String(years.at(-1))}
              onChange={(v) => update({ seasonFrom: v })}
              options={years.map(String)}
            />
            <SelectPicker
              style={{ width: 140 }}
              label={t("截至年份", "Through year")}
              value={params.get("seasonTo") ?? String(years[0])}
              onChange={(v) => update({ seasonTo: v })}
              options={years
                .filter(
                  (y) => y >= Number(params.get("seasonFrom") ?? years.at(-1)),
                )
                .map(String)}
            />
          </div>
        )}
        <div className="mx-toolbar">
          <span className="mx-unit">
            {matrix.length
              ? sampleMonths.length
                ? `${sampleMonths[0]} — ${sampleMonths.at(-1)}`
                : t("无完整月份", "No completed months")
              : `${str(coverage.firstSession).slice(0, 7)} — ${str(coverage.lastSession).slice(0, 7)}`}
          </span>
          <Segments
            label={t("季节性统计", "Seasonality statistic")}
            value={measure}
            onChange={setMeasure}
            options={[
              { value: "meanReturn", label: t("均值", "Mean") },
              { value: "medianReturn", label: t("中位数", "Median") },
            ]}
          />
        </div>
        <div
          className="mx-month-calendar grid grid-cols-12 gap-1 max-[1101px]:grid-cols-6 max-[1101px]:gap-2 max-phone:grid-cols-4"
          role="group"
          aria-label={t("各月历史表现", "Historical performance by month")}
        >
          {rows.map((row) => {
            const cellTone = tone(row[measure as keyof typeof row]);
            const toned = cellTone === "up" || cellTone === "down";
            return (
              <button
                key={Number(row.month)}
                type="button"
                className={cn(
                  "mx-month-cell tm-heat-subtle min-w-0 cursor-pointer rounded-[7px] border border-transparent px-[3px] py-3.5 font-[inherit] max-phone:py-3",
                  "hover:enabled:outline hover:enabled:outline-1 hover:enabled:outline-offset-2 hover:enabled:outline-border",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  "aria-pressed:border-link disabled:cursor-default disabled:opacity-55",
                  "forced-colors:aria-pressed:border-[ButtonText] forced-colors:focus-visible:outline-[Highlight]",
                  !toned && "bg-muted",
                  "mx-" + cellTone,
                )}
                data-tone={toned ? cellTone : undefined}
                aria-pressed={selected.month === row.month}
                onClick={() => setMonth(Number(row.month))}
              >
                <span className="mb-2 block text-[12px] text-muted-foreground">{months[Number(row.month) - 1]}</span>
                <strong className="block text-[15px] font-semibold tabular-nums">
                  {percent(row[measure as keyof typeof row], true, 1)}
                </strong>
                {/* Only a thin sample needs its count. */}
                {(numeric(row.observations) ?? 0) < THIN_SAMPLE && (
                  <small className="mx-thin-sample mt-1 block text-warning">n={number(row.observations, 0)}</small>
                )}
              </button>
            );
          })}
        </div>
        <div className="mx-season-detail" aria-live="polite">
          <h3>{months[Number(selected.month) - 1]}</h3>
          <Facts
            rows={[
              [
                t("平均涨跌", "Mean return"),
                percent(selected.meanReturn, true, 2),
              ],
              [
                t("中位数", "Median return"),
                percent(selected.medianReturn, true, 2),
              ],
              [t("上涨月份占比", "Positive months"), percent(selected.hitRate)],
              [
                t("完整月份样本", "Completed month samples"),
                number(selected.observations, 0),
              ],
              [t("最好月份", "Best month"), percent(selected.best, true, 2)],
              [t("最差月份", "Worst month"), percent(selected.worst, true, 2)],
            ]}
          />
        </div>
        {!!matrix.length && (
          <div
            className="mx-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("年份与月份收益矩阵", "Year-by-month return matrix")}
          >
            <table className="mx-financial-table mx-season-table">
              <thead>
                <tr>
                  <th>{t("年份", "Year")}</th>
                  {months.map((m) => (
                    <th key={m}>{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleYears.map((year) => (
                  <tr key={year}>
                    <th>{year}</th>
                    {months.map((_, i) => {
                      const value = numeric(
                        cellIndex.get(`${year}-${i + 1}`)
                          ?.return,
                      );
                      const direction =
                        value == null || value === 0
                          ? undefined
                          : value > 0
                            ? "up"
                            : "down";
                      return (
                        <td
                          key={i}
                          className="tm-heat-subtle p-0 text-center"
                          data-direction={direction}
                          data-tone={direction}
                        >
                          <button
                            className="w-full border-0 bg-transparent px-2 py-3 text-inherit tabular-nums focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                            aria-label={`${year} ${months[i]} ${percent(value, true, 2)}`}
                            onClick={() => setMonth(i + 1)}
                          >
                            {percent(value, true, 1)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {!!availablePaths.length && (
        <Panel
          title={t("年内价格路径", "Within-year price paths")}
          help={t(
            "以上一年度最后一个已记录收盘价为零点，按日历日期对齐；闰年保留 2 月 29 日。每条线止于实际记录，不延伸至未来。",
            "Each year starts from the preceding year's last recorded close. Calendar dates align, including February 29. Lines stop at their last observation and never extend into the future.",
          )}
          action={
            <div className="flex flex-wrap items-center gap-mx-xs">
              <MultiPicker
                style={{ width: 250 }}
                maxValues={5}
                aria-label={t("对比年份", "Compare years")}
                removeLabel={(option) => t("移除年份 ", "Remove year ") + option.label}
                value={paths}
                onChange={setChosen}
                options={availablePaths}
              />
              <SelectPicker
                style={{ width: 135 }}
                aria-label={t("年内路径基准", "Year-path benchmark")}
                value={benchmarkSymbol}
                onChange={(v) => update({ seasonBenchmark: v })}
                options={[
                  { value: "none", label: t("无基准", "No benchmark") },
                  { value: "SPY", label: "SPY · ETF" },
                  { value: "QQQ", label: "QQQ · ETF" },
                ]}
              />
            </div>
          }
        >
          {benchmarkSymbol !== "none" &&
            !benchmark.isPending &&
            (!comparable || !Object.keys(benchmarkPaths).length) && (
              <p role="status">
                {t(
                  "当前选择没有同币种、同年份的基准记录",
                  "No benchmark records for the selected currency and years",
                )}
              </p>
            )}
          <Plot
            label={t(
              "不同年份的真实价格路径",
              "Observed price paths across years",
            )}
            height={320}
            readout={seasonReadout}
            option={(c) => ({
              grid: { left: 64, right: 20, top: 20, bottom: 55 },
              legend: {
                bottom: 0,
                type: "scroll",
                textStyle: { color: c.text },
              },
              xAxis: {
                type: "value",
                min: 0,
                max: 365,
                interval: 61,
                axisLabel: {
                  color: c.axis,
                  formatter: (n: number) =>
                    new Intl.DateTimeFormat(t("zh-CN", "en"), {
                      month: "short",
                      timeZone: "UTC",
                    }).format(new Date(Date.UTC(2000, 0, 1 + n))),
                },
                splitLine: { show: false },
              },
              yAxis: {
                type: "value",
                axisLabel: {
                  color: c.axis,
                  formatter: (n: number) => minus(percent(n)),
                },
              },
              series: pathLines.map((line) => {
                const stroke = seasonStroke(c, line.year, line.benchmark);
                return {
                  type: "line" as const,
                  name: line.name,
                  data: line.series,
                  showSymbol: false,
                  connectNulls: false,
                  color: stroke.colour,
                  itemStyle: { color: stroke.colour },
                  lineStyle: { width: stroke.width, color: stroke.colour, type: stroke.type },
                };
              }),
            })}
          />
          <details className="mx-chart-data" onToggle={(event) => setRecordsOpen(event.currentTarget.open)}>
            <summary>{t("所选年份价格记录", "Selected year records")}</summary>
            <div className="mx-table-scroll">
              <table className="mx-financial-table">
                <thead>
                  <tr>
                    <th>{t("日期", "Date")}</th>
                    <th>{t("年内变化", "Year-to-date change")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recordsOpen && Object.entries(chartPaths).flatMap(([year, values]) =>
                    values.map((p) => (
                      <tr key={year + str(p.date)}>
                        <th>
                          {formatCalendarDate(str(p.date), locale, 0)}{year.includes(" · ") ? " · " + year.split(" · ")[1] : ""}
                        </th>
                        <td>{minus(percent(p.return, true, 2))}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </details>
        </Panel>
      )}
    </>
  );
}
