"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Drawer, Group, Select } from "@mantine/core";
import { useState } from "react";
import { Legend, Plot } from "./charts";
import { compact, number, percent } from "@/workspace/data";
import { Empty, Metric, Panel, Segments, useCopy } from "./foundation";
import { FinancialStatements } from "./research-company";
import {
  BusinessSegments,
  CompanyOwnership,
  DividendHistory,
} from "./research-evidence";
import {
  factIndex,
  factPeriods,
  incomeBridge,
  metricNames,
  type Observation,
} from "./research-facts";
import { useRouteState } from "./route-state";
import { chartName, chartNumber } from "./research-chart-format";

export function FinancialWorkbench({
  data,
  initialMode,
}: {
  data: ResearchLensSnapshot;
  initialMode?: string;
}) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const [detail, setDetail] = useState<Observation | null>(null);
  const facts = data.financialFacts;
  if (!facts?.periods?.length)
    return (
      <Panel>
        <Empty title={t("暂无可用财报", "No financial statements available")} />
      </Panel>
    );
  const mode = params.get("financialMode") ?? initialMode ?? "performance";
  const requestedFrequency = [
    "annual",
    "quarterly",
    "ttm",
    "semiannual",
    "irregular",
  ].includes(params.get("frequency") ?? "")
    ? params.get("frequency")!
    : "annual";
  const frequency =
    mode === "business" && requestedFrequency === "ttm"
      ? "annual"
      : requestedFrequency;
  const periods = factPeriods(facts, frequency);
  const period =
    periods.find((p) => p.id === params.get("period")) ?? periods.at(-1);
  const chart = params.get("metricGroup") ?? "income";
  const weightedShares = params.get("shareBasis") === "weighted";
  const get = factIndex(facts);
  const label = (key: string) =>
    metricNames[key]
      ? t(...metricNames[key])
      : key === "taxAndOther"
        ? t("税费及其他净项", "Tax & other net items")
        : key;
  const format = (o?: Observation) =>
    o?.value == null
      ? "—"
      : o.unit === "ratio"
        ? percent(o.value, false, 2)
        : o.unit === "perShare"
          ? number(o.value, 2)
          : compact(o.value);
  const selected = (key: string) => (period ? get(period.id, key) : undefined);
  const groups: Record<string, string[]> = {
    income: ["revenue", "operatingIncome", "netIncome"],
    margins: ["grossMargin", "operatingMargin", "netMargin"],
    cashflow: ["operatingCashflow", "capex", "freeCashflow"],
    balance: ["cash", "debt"],
    returns: ["roe", "roa"],
    shares: weightedShares
      ? ["basicShares", "dilutedShares"]
      : ["shareCount", "dilutedShares"],
    allocation: ["freeCashflow", "buybacks", "dividends"],
  };
  const chartMetrics = groups[chart] ?? groups.income;
  const ratio = chart === "margins" || chart === "returns";
  const statementMetrics =
    mode === "balance"
      ? ["cash", "assets", "debt", "equity", "shareCount"]
      : mode === "cash"
        ? [
            "operatingCashflow",
            "capex",
            "freeCashflow",
            "buybacks",
            "dividends",
          ]
        : [
            "revenue",
            "revenueGrowth",
            "costOfRevenue",
            "grossProfit",
            "grossMargin",
            "operatingExpense",
            "operatingIncome",
            "operatingMargin",
            "pretaxIncome",
            "tax",
            "netIncome",
            "netMargin",
            "eps",
            "epsGrowth",
            "dilutedShares",
          ];
  const bridge = incomeBridge((key) => selected(key)?.value);
  const activeDetail =
    detail ??
    (params.get("fact") ? (selected(params.get("fact")!) ?? null) : null);
  return (
    <>
      <div className="mx-research-context-toolbar">
        <Segments
          label={t("财务内容", "Financial workspace")}
          value={mode}
          onChange={(v) => update({ financialMode: v })}
          options={[
            { value: "performance", label: t("经营分析", "Performance") },
            { value: "income", label: t("利润表", "Income") },
            { value: "balance", label: t("资产负债表", "Balance sheet") },
            { value: "cash", label: t("现金流量表", "Cash flow") },
            { value: "business", label: t("业务分部", "Segments") },
            {
              value: "ownership",
              label: t("股权与分红", "Ownership & dividends"),
            },
            { value: "full", label: t("完整报表", "All reported rows") },
          ]}
        />
        {mode !== "ownership" && (
          <Group gap="xs">
            <Segments
              label={t("财务期间", "Financial frequency")}
              value={frequency}
              onChange={(v) => update({ frequency: v, period: null })}
              options={[
                { value: "annual", label: t("年度", "Annual") },
                { value: "quarterly", label: t("季度", "Quarterly") },
                { value: "ttm", label: "TTM" },
                ...(facts.periods.some((p) => p.kind === "semiannual")
                  ? [{ value: "semiannual", label: t("半年度", "Half-year") }]
                  : []),
                ...(facts.periods.some((p) => p.kind === "irregular")
                  ? [{ value: "irregular", label: t("过渡期", "Transition") }]
                  : []),
              ]}
            />
            <Select
              aria-label={t("选择报告期", "Reporting period")}
              value={period?.id ?? null}
              data={[...periods]
                .reverse()
                .map((p) => ({ value: p.id, label: p.label }))}
              onChange={(v) => update({ period: v })}
              w={205}
            />
          </Group>
        )}
      </div>
      {!period ? (
        <Panel>
          <Empty
            title={t(
              "没有完整的四个季度",
              "Four complete quarters are unavailable",
            )}
          />
        </Panel>
      ) : (
        <>
          {mode !== "ownership" && (
            <Panel
              title={period.label}
              action={
                <span className="mx-unit">
                  {facts.currency ?? t("币种未提供", "Currency unavailable")}
                </span>
              }
            >
              <div className="mx-metric-grid">
                {["revenue", "revenueGrowth", "netMargin", "freeCashflow"].map(
                  (key) => (
                    <button
                      type="button"
                      className="mx-fact-button"
                      key={key}
                      onClick={() => setDetail(selected(key) ?? null)}
                    >
                      <Metric
                        label={label(key)}
                        value={format(selected(key))}
                      />
                    </button>
                  ),
                )}
              </div>
            </Panel>
          )}
          {mode === "performance" ? (
            <>
              <Panel
                title={t("经营历史", "Operating history")}
                help={
                  chart === "shares"
                    ? t(
                        "期末股数是时点余额，平均股数是期间加权值，两者的差额不代表稀释。EPS 股数视图对照同期间基本与摊薄平均股数；TTM 使用四个季度平均值。",
                        "Period-end shares are a balance; weighted-average shares cover a period. Their difference is not dilution. The EPS view compares basic and diluted averages for the same period; TTM uses four-quarter means.",
                      )
                    : undefined
                }
                action={
                  <Select
                    aria-label={t("历史指标", "Historical metrics")}
                    value={chart}
                    onChange={(v) => update({ metricGroup: v })}
                    data={[
                      {
                        value: "income",
                        label: t("营收与利润", "Revenue & profit"),
                      },
                      { value: "margins", label: t("利润率", "Margins") },
                      {
                        value: "cashflow",
                        label: t("现金流", "Cash generation"),
                      },
                      {
                        value: "balance",
                        label: t("现金与债务", "Cash & debt"),
                      },
                      {
                        value: "returns",
                        label: t("资本回报", "Capital returns"),
                      },
                      {
                        value: "shares",
                        label: t("股数变化", "Share-count changes"),
                      },
                      {
                        value: "allocation",
                        label: t("股东回报", "Capital allocation"),
                      },
                    ]}
                  />
                }
              >
                {chart === "shares" && (
                  <Segments
                    label={t("股数口径", "Share-count basis")}
                    value={weightedShares ? "weighted" : "outstanding"}
                    onChange={(v) =>
                      update({ shareBasis: v === "weighted" ? v : null })
                    }
                    options={[
                      {
                        value: "outstanding",
                        label: t("期末与平均股数", "Period-end & average"),
                      },
                      {
                        value: "weighted",
                        label: t("EPS 加权股数", "EPS weighted averages"),
                      },
                    ]}
                  />
                )}
                <Plot
                  label={t("经营历史", "Operating history")}
                  height={320}
                  option={(c) => ({
                    grid: {
                      left: 70,
                      right: ratio ? 78 : chart === "shares" ? 68 : 20,
                      top: 25,
                      bottom: 45,
                    },
                    xAxis: {
                      type: "category",
                      data: periods.map((p) => p.label),
                      axisLabel: { color: c.axis },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    },
                    yAxis: {
                      type: "value",
                      scale: chart === "shares" || ratio,
                      axisLabel: {
                        color: c.axis,
                        formatter: (n: number) =>
                          ratio ? percent(n) : compact(n),
                      },
                      splitLine: {
                        lineStyle: { color: c.grid, type: "dashed" },
                      },
                    },
                    tooltip: {
                      formatter: (input) => {
                        const entries = Array.isArray(input) ? input : [input];
                        return [
                          String(entries[0]?.name ?? "") +
                            " · " +
                            (ratio
                              ? "%"
                              : chart === "shares"
                                ? t("股", "shares")
                                : (facts.currency ?? "")),
                          ...entries.map(
                            (e) =>
                              `${chartName(String(e.seriesName))}   ${ratio ? percent(e.value, false, 2) : chartNumber(e.value)}`,
                          ),
                        ].join("\n");
                      },
                    },
                    series: chartMetrics.map((key, i) => ({
                      type: ratio || chart === "shares" ? "line" : "bar",
                      name: label(key),
                      data: periods.map((p) => get(p.id, key)?.value ?? null),
                      connectNulls: false,
                      showSymbol: periods.length < 6,
                      symbolSize: 6,
                      barMaxWidth: 34,
                      itemStyle: { color: [c.brand, c.secondary, c.accent][i] },
                      endLabel:
                        ratio || chart === "shares"
                          ? {
                              show: true,
                              formatter: (p) =>
                                chart === "shares"
                                  ? compact(p.value)
                                  : label(key),
                              color: c.text,
                              fontSize: 11,
                            }
                          : undefined,
                      labelLayout: { moveOverlap: "shiftY" },
                    })),
                  })}
                />
                <Legend
                  items={chartMetrics.map((key, i) => ({
                    label: label(key),
                    colour: [
                      "var(--mx-chart-0)",
                      "var(--mx-chart-2)",
                      "var(--mx-chart-1)",
                    ][i],
                  }))}
                />
                <div
                  className="mx-table-scroll"
                  role="region"
                  aria-label={t("图表数据", "Chart data")}
                  tabIndex={0}
                >
                  <table className="mx-financial-table">
                    <thead>
                      <tr>
                        <th>{t("报告期", "Period")}</th>
                        {chartMetrics.map((key) => (
                          <th key={key}>{label(key)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...periods].reverse().map((p) => (
                        <tr
                          key={p.id}
                          data-active={p.id === period.id || undefined}
                        >
                          <th>
                            <button onClick={() => update({ period: p.id })}>
                              {p.label}
                            </button>
                          </th>
                          {chartMetrics.map((key) => (
                            <td key={key}>
                              <button
                                onClick={() =>
                                  setDetail(get(p.id, key) ?? null)
                                }
                              >
                                {format(get(p.id, key))}
                              </button>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              {bridge.length > 0 && (
                <Panel
                  title={t("从营收到净利润", "Revenue to net income")}
                  action={
                    <span className="mx-unit">
                      {period.label} · {facts.currency}
                    </span>
                  }
                >
                  <Plot
                    research
                    label={t("利润桥接", "Income bridge")}
                    height={305}
                    option={(c) => ({
                      xAxis: {
                        type: "category",
                        data: bridge.map((b) => label(b.metric)),
                        axisLabel: {
                          color: c.axis,
                          interval: 0,
                          width: 70,
                          overflow: "break",
                        },
                        axisTick: { show: false },
                      },
                      yAxis: {
                        type: "value",
                        axisLabel: {
                          color: c.axis,
                          formatter: (n: number) => compact(n),
                        },
                        splitLine: {
                          lineStyle: { color: c.grid, type: "dashed" },
                        },
                      },
                      tooltip: {
                        trigger: "axis",
                        formatter: (params) => {
                          const p = (
                            Array.isArray(params) ? params : [params]
                          )[0];
                          const item = bridge[p.dataIndex];
                          return `${label(item.metric)} · ${facts.currency ?? ""}\n${chartNumber(item.to - item.from)}`;
                        },
                      },
                      series: [
                        {
                          type: "custom",
                          data: bridge.map((b, i) => [i, b.from, b.to]),
                          encode: { x: 0, y: [1, 2] },
                          renderItem: (p, api) => {
                            const i = Number(api.value(0));
                            const from = api.coord([i, api.value(1)]);
                            const to = api.coord([i, api.value(2)]);
                            const size = api.size?.([1, 0]);
                            const width = Math.min(
                              58,
                              Math.abs(
                                Array.isArray(size) ? size[0] : (size ?? 40),
                              ) * 0.55,
                            );
                            const b = bridge[i];
                            return {
                              type: "rect",
                              shape: {
                                x: from[0] - width / 2,
                                y: Math.min(from[1], to[1]),
                                width,
                                height: Math.max(1, Math.abs(to[1] - from[1])),
                              },
                              style: {
                                fill: b.total
                                  ? c.brand
                                  : b.to < b.from
                                    ? c.negative
                                    : c.positive,
                              },
                            };
                          },
                        },
                      ],
                    })}
                  />
                  <div className="mx-bridge-values">
                    {bridge.map((b) => (
                      <button
                        key={b.metric}
                        onClick={() =>
                          setDetail(
                            selected(b.metric) ?? selected("netIncome") ?? null,
                          )
                        }
                      >
                        <span>{label(b.metric)}</span>
                        <strong>{compact(b.to - b.from)}</strong>
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
            </>
          ) : mode === "business" ? (
            <BusinessSegments data={data} />
          ) : mode === "ownership" ? (
            <>
              <CompanyOwnership data={data} />
              <DividendHistory data={data} />
            </>
          ) : mode === "full" ? (
            <FinancialStatements data={data} controlledFrequency={frequency} />
          ) : (
            <Panel title={t("财务报表", "Financial statements")}>
              <div
                className="mx-table-scroll"
                role="region"
                aria-label={t("财务数据", "Financial data")}
                tabIndex={0}
              >
                <table className="mx-financial-table">
                  <thead>
                    <tr>
                      <th>{facts.currency}</th>
                      {[...periods].reverse().map((p) => (
                        <th key={p.id}>
                          {p.label}
                          {p.actualEnd && <small>{p.actualEnd}</small>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {statementMetrics
                      .filter((key) =>
                        periods.some((p) => get(p.id, key)?.value != null),
                      )
                      .map((key) => (
                        <tr
                          key={key}
                          className={
                            /Margin|Growth/.test(key) ? "mx-submetric" : ""
                          }
                        >
                          <th>{label(key)}</th>
                          {[...periods].reverse().map((p) => (
                            <td key={p.id}>
                              <button
                                onClick={() =>
                                  setDetail(get(p.id, key) ?? null)
                                }
                              >
                                {format(get(p.id, key))}
                              </button>
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
      <Drawer
        position="right"
        size="lg"
        opened={Boolean(activeDetail)}
        onClose={() => {
          setDetail(null);
          update({ fact: null });
        }}
        title={activeDetail ? label(activeDetail.metric) : ""}
      >
        {activeDetail && (
          <div className="mx-stack">
            <div className="mx-detail-value">
              {activeDetail.unit === "ratio"
                ? percent(activeDetail.value, false, 2)
                : number(
                    activeDetail.value,
                    activeDetail.unit === "shares" ? 0 : 4,
                  )}{" "}
              <small>{activeDetail.unit === "ratio" ? "" : activeDetail.currency}</small>
            </div>
            <p>
              {
                facts.periods?.find((p) => p.id === activeDetail.periodId)
                  ?.label
              }
            </p>
            {activeDetail.reason && (
              <p>
                {t("无法计算：", "Unavailable: ")}
                {activeDetail.reason}
              </p>
            )}
            {activeDetail.formula && <p>{activeDetail.formula}</p>}
            <Plot
              label={label(activeDetail.metric)}
              height={220}
              option={(c) => ({
                xAxis: {
                  type: "category",
                  data: periods.map((p) => p.label),
                  axisLabel: { color: c.axis },
                },
                yAxis: {
                  type: "value",
                  scale: true,
                  axisLabel: {
                    color: c.axis,
                    formatter: (n: number) =>
                      activeDetail.unit === "ratio" ? percent(n) : compact(n),
                  },
                },
                tooltip: {
                  valueFormatter: (value) => activeDetail.unit === "ratio" ? percent(value, false, 2) : chartNumber(value),
                },
                series: [
                  {
                    type: "line",
                    connectNulls: false,
                    data: periods.map(
                      (p) => get(p.id, activeDetail.metric)?.value ?? null,
                    ),
                    lineStyle: { color: c.brand },
                    symbolSize: 6,
                  },
                ],
              })}
            />
            <h3>{t("数据来源", "Source evidence")}</h3>
            <ul className="mx-source-list">
              {(activeDetail.evidence ?? []).map((source, i) => (
                <li key={i}>
                  <strong>{source.field}</strong>
                  <span>{source.source}</span>
                  {source.publishedAt && <time>{source.publishedAt}</time>}
                  {source.url && (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {t("原始披露", "Original filing")} ↗
                    </a>
                  )}
                  <code>{source.version.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
            <Button
              variant="default"
              onClick={() => {
                update({ financialMode: "full" });
                setDetail(null);
              }}
            >
              {t("查看完整报表", "Open complete statement")}
            </Button>
          </div>
        )}
      </Drawer>
    </>
  );
}
