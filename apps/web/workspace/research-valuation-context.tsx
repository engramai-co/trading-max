"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { useState, type ReactNode } from "react";
import { Plot } from "./charts";
import {
  compact,
  number,
  numeric,
  object,
  objects,
  percent,
  safeUrl,
  str,
} from "./data";
import { EvidenceTable } from "./evidence-table";
import { Empty, Facts, Panel, Segments, TextLink, useCopy } from "./foundation";
import { factIndex } from "./research-facts";

export function ModelAlternatives({
  data,
  financial,
}: {
  data: ResearchLensSnapshot;
  financial: boolean;
}) {
  const t = useCopy();
  const facts = data.financialFacts;
  const period =
    facts?.periods.find((p) => p.id === facts.latestTtm) ??
    facts?.periods
      .filter((p) => p.kind === "annual")
      .sort((a, b) => b.providerEnd.localeCompare(a.providerEnd))[0];
  const get = facts ? factIndex(facts) : () => undefined;
  const value = (key: string) => (period ? get(period.id, key)?.value : null);
  const q = data.context?.quote;
  const shares = value("shareCount"),
    equity = value("equity");
  const pb =
    q?.currency === facts?.currency &&
    q?.price &&
    shares &&
    equity &&
    equity > 0
      ? (q.price * shares) / equity
      : null;
  return (
    <Panel
      title={
        financial
          ? t("权益与盈利能力", "Equity & profitability")
          : t("现金流与融资", "Cash flow & financing")
      }
      action={<span>{facts?.currency}</span>}
      help={
        financial
          ? t(
              "银行与保险公司的资本结构不适用一般企业的经营现金流减资本开支模型。P/B 使用当前股价、报告期末股数和股东权益；有形净资产采用原报表定义。",
              "Bank and insurance balance sheets do not fit the generic operating-cash-flow model. P/B pairs the current quote with reported period-end shares and equity; tangible assets retain their reported definition.",
            )
          : undefined
      }
    >
      <Facts
        rows={
          financial
            ? [
                [t("财务期间", "Financial period"), period?.label ?? "—"],
                ["P/B", pb == null ? "—" : number(pb, 2) + "×"],
                ["ROE", percent(value("roe"))],
                ["ROA", percent(value("roa"))],
                [
                  t("股东权益", "Shareholders’ equity"),
                  compact(equity) + " " + (facts?.currency ?? ""),
                ],
                [
                  t("有形净资产", "Net tangible assets"),
                  compact(value("tangibleEquity")) +
                    " " +
                    (facts?.currency ?? ""),
                ],
              ]
            : [
                [t("财务期间", "Financial period"), period?.label ?? "—"],
                [t("营业收入", "Revenue"), compact(value("revenue"))],
                [
                  t("现金及短期投资", "Cash & investments"),
                  compact(value("cash")),
                ],
                [
                  t("经营现金流", "Operating cash flow"),
                  compact(value("operatingCashflow")),
                ],
                [t("现金流率", "FCF margin"), percent(value("fcfMargin"))],
                [
                  t("期末股数", "Period-end shares"),
                  compact(value("shareCount")),
                ],
              ]
        }
      />
      <TextLink
        href={`/research?ticker=${encodeURIComponent(data.ticker)}&view=fundamentals&metricGroup=${financial ? "returns" : "cashflow"}`}
      >
        {t("查看财务与原始披露", "Financials & original disclosures")}
      </TextLink>
    </Panel>
  );
}

export function FilingMultiples({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [requested, setRequested] = useState("ps");
  const evidence = object(data.researchEvidence);
  const sales = objects(evidence.releaseSalesMultiples);
  const mode = requested === "ps" && sales.length ? "ps" : "pe";
  const rows = mode === "ps" ? sales : objects(evidence.releaseMultiples);
  const ratio = mode === "ps" ? "P/S" : "P/E";
  const code = str(rows[0]?.currency);
  const samples = rows
    .map((r) => numeric(r[mode]))
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length
    ? samples.length % 2
      ? samples[middle]
      : (samples[middle - 1] + samples[middle]) / 2
    : null;
  const quote = data.context?.quote;
  const revenue = data.financialFacts?.observations.find(
    (o) =>
      o.metric === "revenue" && o.periodId === data.financialFacts?.latestTtm,
  )?.value;
  const shares = numeric(data.valuation?.assumptions.sharesOutstanding);
  const current =
    mode === "ps" &&
    quote?.currency === data.financialFacts?.currency &&
    revenue &&
    shares &&
    quote?.price
      ? (quote.price * shares) / revenue
      : null;
  const rank =
    current != null && samples.length >= 8
      ? samples.filter((v) => v <= current).length / samples.length
      : null;
  const points = rows.flatMap((r, i) => {
    const stamp = Date.parse(str(r.priceDate));
    const previous = i ? Date.parse(str(rows[i - 1].priceDate)) : stamp;
    const point = { value: [stamp, numeric(r[mode])], rowIndex: i };
    return stamp - previous > 130 * 86400000
      ? [{ value: [(stamp + previous) / 2, null], rowIndex: -1 }, point]
      : [point];
  });
  return (
    <Panel
      title={t("披露时的估值", "Valuation at disclosure")}
      className="mx-multiple-context"
      action={
        sales.length > 0 ? (
          <Segments
            label={t("历史估值口径", "Historical multiple basis")}
            value={mode}
            onChange={setRequested}
            options={[
              { value: "ps", label: "P/S · TTM" },
              { value: "pe", label: t("P/E · 年度", "P/E · Annual") },
            ]}
          />
        ) : undefined
      }
      help={
        mode === "ps"
          ? t(
              "以披露后首个交易日收盘价、当时披露的普通股股数及TTM营收计算。TTM营收＝上一财年＋本年累计－上年同期累计；缺期间不外推。股数调整其日期后的拆股，ADR转换不明确时不计算。分位仅针对所示披露样本，至少需8个有效样本；不代表每日历史分位。",
              "Next-session close × common shares known at publication / TTM revenue. Revenue is prior FY + current fiscal YTD − prior fiscal YTD; incomplete periods are excluded. Shares account for subsequent splits. Unknown ADR ratios are unsupported. Percentile uses the displayed filing sample, requires eight valid observations, and is not a daily-history percentile.",
            )
          : t(
              "以该文件当时披露的年度摊薄 EPS，配对披露后首个交易日的收盘价；历史价格恢复为当时拆股口径。这里只比较有原始文件的披露节点，不是连续 TTM 或历史远期 P/E。负 EPS 不计算 P/E。",
              "Annual diluted EPS as filed is paired with the next session’s closing price, restored to the share basis at that date. These are filing-date observations, not a continuous TTM or historical forward P/E series. Negative EPS has no meaningful P/E.",
            )
      }
    >
      {!rows.length ? (
        <Empty
          title={t(
            "暂无可核对的历史估值记录",
            "No verifiable historical multiples",
          )}
        />
      ) : (
        <>
          <Facts
            rows={[
              [
                t("样本窗口", "Sample window"),
                `${str(rows[0]?.priceDate)} → ${str(rows.at(-1)?.priceDate)}`,
              ],
              [t("披露样本", "Filing observations"), String(samples.length)],
              [t("样本中位数", "Sample median"), `${number(median, 2)}×`],
              [
                t("样本范围", "Sample range"),
                `${number(samples[0], 2)}–${number(samples.at(-1), 2)}×`,
              ],
              ...(mode === "ps"
                ? ([
                    [
                      t("当前 P/S", "Current P/S"),
                      current == null ? "—" : `${number(current, 2)}×`,
                    ],
                    [
                      t(
                        "当前值在样本中的分位",
                        "Current value percentile in sample",
                      ),
                      percent(rank),
                    ],
                  ] as [ReactNode, ReactNode][])
                : []),
            ]}
          />
          <Plot
            research
            height={225}
            label={
              mode === "ps"
                ? t("披露节点的 TTM P/S", "TTM P/S at filing dates")
                : t("披露节点的年度 P/E", "Annual P/E at filing dates")
            }
            option={(c) => ({
              xAxis:
                mode === "ps"
                  ? {
                      type: "time",
                      axisLabel: {
                        color: c.axis,
                        hideOverlap: true,
                        formatter: "{yyyy}-{MM}",
                      },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    }
                  : {
                      type: "category",
                      data: rows.map((r) => str(r.priceDate)),
                      axisLabel: { color: c.axis, hideOverlap: true },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    },
              yAxis: {
                type: "value",
                name: ratio + " · ×",
                scale: true,
                axisLabel: { color: c.axis },
                splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
              },
              series: [
                {
                  type: mode === "ps" ? "line" : "scatter",
                  symbolSize: 9,
                  data:
                    mode === "ps" ? points : rows.map((r) => numeric(r[mode])),
                  connectNulls: false,
                  itemStyle: { color: c.brand },
                },
              ],
              tooltip: {
                formatter: (input) => {
                  const point = Array.isArray(input) ? input[0] : input;
                  const index =
                    mode === "ps"
                      ? numeric(object(point?.data).rowIndex)
                      : point?.dataIndex;
                  const r = index == null ? undefined : rows[index];
                  return r
                    ? `${str(r.priceDate)}\n${ratio}  ${number(r[mode], 2)}×\n${mode === "ps" ? `TTM ${compact(r.revenue)}` : `EPS ${number(r.eps, 2)}`} ${code}`
                    : "";
                },
              },
            })}
          />
          <EvidenceTable
            label={t("历史估值证据", "Historical valuation evidence")}
            rows={rows}
            columns={[
              { label: t("披露日", "Filed"), value: (r) => str(r.publishedAt) },
              {
                label: t("收盘日", "Price date"),
                value: (r) => str(r.priceDate),
              },
              {
                label:
                  mode === "ps"
                    ? t("TTM 截至", "TTM ending")
                    : t("年度截至", "FY ending"),
                value: (r) => str(r.periodEnd),
              },
              {
                label:
                  (mode === "ps" ? t("TTM 营收", "TTM revenue") : "EPS") +
                  " · " +
                  code,
                value: (r) =>
                  mode === "ps" ? compact(r.revenue) : number(r.eps, 2),
                numeric: true,
              },
              {
                label: t("收盘价", "Close") + " · " + code,
                value: (r) => number(r.price, 2),
                numeric: true,
              },
              {
                label: ratio,
                value: (r) =>
                  r.state === "notMeaningful"
                    ? "N/M"
                    : numeric(r[mode]) == null
                      ? "—"
                      : number(r[mode], 2) + "×",
                numeric: true,
              },
              {
                label: t("原文", "Filing"),
                value: (r) =>
                  safeUrl(str(r.url)) ? (
                    <a
                      href={safeUrl(str(r.url))}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("查看", "Open")} ↗
                    </a>
                  ) : (
                    "—"
                  ),
              },
              ...(mode === "ps"
                ? [
                    {
                      label: t("计算输入", "Calculation inputs"),
                      value: (r: Record<string, unknown>) => (
                        <details>
                          <summary>{t("查看", "Open")}</summary>
                          <p>
                            {t("普通股股数", "Common shares")}:{" "}
                            {compact(r.shares)} · {str(r.shareDate)}
                          </p>
                          {objects(r.components).map((o, i) => (
                            <p key={i}>
                              {str(o.periodStart)} → {str(o.periodEnd)} ·{" "}
                              {compact(o.value)} {code}{" "}
                              {safeUrl(str(o.url)) && (
                                <a
                                  href={safeUrl(str(o.url))}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  ↗ {t("原始披露", "Filing")}
                                </a>
                              )}
                            </p>
                          ))}
                        </details>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      )}
    </Panel>
  );
}
