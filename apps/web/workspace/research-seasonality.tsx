"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Group, MultiSelect, Pill, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Plot } from "./charts";
import {
  number,
  numeric,
  object,
  objects,
  percent,
  str,
  tone,
} from "./data";
import { Facts, Panel, Segments, useCopy } from "./foundation";
import { researchPriceQuery } from "./research-queries";
import { useRouteState } from "./route-state";

export function Seasonality({ data, revision }: { data: ResearchLensSnapshot; revision?: string | null }) {
  const t = useCopy();
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
  const years = [...new Set(matrix.map((r) => Number(r.year)))].sort(
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
  const availablePaths = Object.keys(yearPaths).sort().reverse(),
    paths = chosen ?? availablePaths.slice(0, 3);
  const comparable = benchmark.data?.currency === data.context?.quote.currency;
  const benchmarkPaths: Record<string, Record<string, unknown>[]> = {};
  if (comparable) {
    const points = [...(benchmark.data?.points ?? [])].sort((a, b) =>
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
  return (
    <>
      <Panel
        title={t("月度季节性", "Monthly seasonality")}
        help={t(
          "仅以完整交易月份计算历史统计；当月未结束和缺少月末收盘的月份不入样本。数值来自拆股及分红调整后价格。选择年份会同时重算均值、中位数和上涨比例。",
          "Only completed exchange months enter historical statistics. Unfinished months and missing month-end closes are excluded. Returns use split and dividend adjusted prices. Selecting years recalculates every statistic.",
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
                { value: "custom", label: t("自选", "Custom") },
              ]}
            />
          ) : undefined
        }
      >
        {matrix.length > 0 && window === "custom" && (
          <Group mb="md">
            <Select
              w={140}
              label={t("起始年份", "From year")}
              value={params.get("seasonFrom") ?? String(years.at(-1))}
              onChange={(v) => update({ seasonFrom: v })}
              data={years.map(String)}
            />
            <Select
              w={140}
              label={t("截至年份", "Through year")}
              value={params.get("seasonTo") ?? String(years[0])}
              onChange={(v) => update({ seasonTo: v })}
              data={years
                .filter(
                  (y) => y >= Number(params.get("seasonFrom") ?? years.at(-1)),
                )
                .map(String)}
            />
          </Group>
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
          className="mx-month-calendar"
          aria-label={t("各月历史表现", "Historical performance by month")}
        >
          {rows.map((row) => (
            <button
              key={Number(row.month)}
              type="button"
              className={
                "mx-month-cell mx-" + tone(row[measure as keyof typeof row])
              }
              aria-pressed={selected.month === row.month}
              onClick={() => setMonth(Number(row.month))}
            >
              <span>{months[Number(row.month) - 1]}</span>
              <strong>
                {percent(row[measure as keyof typeof row], true, 1)}
              </strong>
              <small>n={number(row.observations, 0)}</small>
            </button>
          ))}
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
                      return (
                        <td
                          key={i}
                          data-direction={
                            value == null || value === 0
                              ? undefined
                              : value > 0
                                ? "up"
                                : "down"
                          }
                        >
                          <button
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
            <Group gap="xs">
              <MultiSelect
                w={250}
                maxValues={5}
                aria-label={t("对比年份", "Compare years")}
                renderPill={({ option, onRemove }) => (
                  <Pill
                    withRemoveButton
                    onRemove={onRemove}
                    removeButtonProps={{
                      "aria-label":
                        t("移除年份 ", "Remove year ") + option.label,
                    }}
                  >
                    {option.label}
                  </Pill>
                )}
                value={paths}
                onChange={setChosen}
                data={availablePaths}
              />
              <Select
                w={135}
                aria-label={t("年内路径基准", "Year-path benchmark")}
                value={benchmarkSymbol}
                onChange={(v) => update({ seasonBenchmark: v })}
                data={[
                  { value: "none", label: t("无基准", "No benchmark") },
                  { value: "SPY", label: "SPY · ETF" },
                  { value: "QQQ", label: "QQQ · ETF" },
                ]}
              />
            </Group>
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
                  formatter: (n: number) => percent(n),
                },
                splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
              },
              tooltip: {
                trigger: "item",
                formatter: (item) => {
                  const p = Array.isArray(item) ? item[0] : item;
                  const row = objects(chartPaths[String(p.seriesName)])[
                    p.dataIndex
                  ];
                  return str(row?.date) + "\n" + percent(row?.return, true, 2);
                },
              },
              series: Object.entries(chartPaths).map(([year, values], i) => ({
                type: "line",
                name: year,
                data: values.map((p) => [
                  dayNumber(str(p.day)),
                  numeric(p.return),
                ]),
                showSymbol: false,
                connectNulls: false,
                lineStyle: {
                  width: i === 0 ? 2.1 : 1.2,
                  opacity: i === 0 ? 1 : 0.65,
                  type: year.includes(" · ") ? "dashed" : "solid",
                },
              })),
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
                          {year} · {str(p.date)}
                        </th>
                        <td>{percent(p.return, true, 2)}</td>
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
