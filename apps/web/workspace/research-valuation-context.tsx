"use client";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDate, formatDateSpan } from "@/ui/formatters";
import { useChartColours } from "@/ui/charts/palette";

import type { ResearchLensSnapshot } from "@/lib/types";
import { type ReactNode } from "react";
import { DeferredPlot } from "./research-reading";
import type { ChartReadout, Reading } from "./chart-readout";
import { compact, number, object, objects, percent, safeUrl, str } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { EvidenceTable } from "./evidence-table";
import { Facts, Panel, TextLink, useCopy } from "./foundation";
import { minus } from "./reading-figures";
import { factIndex } from "./research-facts";
import { quoteValue } from "./financial-values";
import type { ResearchPrice } from "./research-price-basis";

export function ModelAlternatives({
  data,
  financial,
}: {
  data: ResearchLensSnapshot;
  financial: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
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
                  compact(equity, locale) + " " + (facts?.currency ?? ""),
                ],
                [
                  t("有形净资产", "Net tangible assets"),
                  compact(value("tangibleEquity"), locale) +
                    " " +
                    (facts?.currency ?? ""),
                ],
              ]
            : [
                [t("财务期间", "Financial period"), period?.label ?? "—"],
                [t("营业收入", "Revenue"), compact(value("revenue"), locale)],
                [
                  t("现金及短期投资", "Cash & investments"),
                  compact(value("cash"), locale),
                ],
                [
                  t("经营现金流", "Operating cash flow"),
                  compact(value("operatingCashflow"), locale),
                ],
                [t("现金流率", "FCF margin"), percent(value("fcfMargin"))],
                [
                  t("期末股数", "Period-end shares"),
                  compact(value("shareCount"), locale),
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

export function FilingMultiples({
  data,
  price,
  mode,
}: {
  data: ResearchLensSnapshot;
  price?: ResearchPrice;
  mode: "pe" | "ps";
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const evidence = object(data.researchEvidence);
  const rows = objects(mode === "ps" ? evidence.releaseSalesMultiples : evidence.releaseMultiples);
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
  const quote = price ?? data.context?.quote;
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
  // A reading names the filing date, leads with the multiple and adds its input;
  // the table below keeps the exact dates and the currency.
  const read = (r: Record<string, unknown>): Reading => {
    const filed = formatCalendarDate(str(r.publishedAt) || str(r.priceDate), locale);
    const multiple = numeric(r[mode]);
    return {
      time: t("{date}披露", "Filed {date}").replace("{date}", filed),
      primary: { value: r.state === "notMeaningful" ? "N/M" : multiple == null ? "—" : number(multiple, 2) + "×" },
      groups: [[mode === "ps"
        ? { label: t("TTM 营收", "TTM revenue"), value: compact(r.revenue, locale) }
        : { label: t("年度 EPS", "Annual EPS"), value: minus(number(r.eps, 2)) }]],
    };
  };
  const plotted = rows.flatMap((r, index) => {
    const stamp = Date.parse(str(r.priceDate));
    return mode === "ps" ? (Number.isFinite(stamp) ? [{ position: stamp, row: r }] : []) : [{ position: index, row: r }];
  }).sort((a, b) => a.position - b.position);
  const at = new Map(plotted.map((point) => [point.position, point.row]));
  const readout: ChartReadout = {
    positions: plotted.map((point) => point.position),
    read: (position) => {
      const r = at.get(position);
      return r ? read(r) : null;
    },
    marks: (position) => {
      const value = numeric(at.get(position)?.[mode]);
      return value == null ? [] : [{ value, colour: colours.brand }];
    },
    latest: plotted.length ? read(plotted.at(-1)!.row).primary?.value ?? "—" : "—",
  };
  return (
    <Panel
      title={mode === "ps" ? t("披露时的市销率", "P/S at disclosure") : t("年度 P/E · 披露样本", "Annual P/E · filing sample")}
      className="mx-multiple-context"
      bare
      help={
        mode === "ps"
          ? t(
              "以披露后首个交易日收盘价、当时披露的普通股股数及 TTM 营收计算。TTM 营收＝上一财年＋本年累计－上年同期累计；缺期间不外推。股数调整其日期后的拆股，ADR 转换不明确时不计算。分位仅针对所示披露样本，至少需 8 个有效样本；不代表每日历史分位。",
              "Next-session close × common shares known at publication / TTM revenue. Revenue is prior FY + current fiscal YTD − prior fiscal YTD; incomplete periods are excluded. Shares account for subsequent splits. Unknown ADR ratios are unsupported. Percentile uses the displayed filing sample, requires eight valid observations, and is not a daily-history percentile.",
            )
          : t(
              "以该文件当时披露的年度摊薄 EPS，配对披露后首个交易日的收盘价；历史价格恢复为当时拆股口径。这里只比较有原始文件的披露节点，不是连续 TTM 或历史远期 P/E。负 EPS 不计算 P/E。",
              "Annual diluted EPS as filed is paired with the next session’s closing price, restored to the share basis at that date. These are filing-date observations, not a continuous TTM or historical forward P/E series. Negative EPS has no meaningful P/E.",
            )
      }
    >
      {!samples.length ? (
        // One line in place of empty axes and a range of dashes.
        <p className="mx-multiple-empty">
          {!rows.length
            ? t("暂无可核对的历史估值记录", "No verifiable historical multiples")
            : mode === "pe" && rows.every((r) => r.state === "notMeaningful")
              ? t("各次披露的年度 EPS 均不为正，P/E 不适用", "Annual EPS was nonpositive at every filing; P/E is not meaningful")
              : t("各次披露均无法计算倍数", "No filing has a calculable multiple")}
        </p>
      ) : (
        <>
          <Facts
            rows={[
              [
                t("样本窗口", "Sample window"),
                formatDateSpan(str(rows[0]?.priceDate), str(rows.at(-1)?.priceDate), locale),
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
                      rank == null ? "—" : "P" + number(rank * 100, 0),
                    ],
                  ] as [ReactNode, ReactNode][])
                : []),
            ]}
          />
          <DeferredPlot
            research
            height={225}
            label={
              mode === "ps"
                ? t("披露节点的 TTM P/S", "TTM P/S at filing dates")
                : t("披露节点的年度 P/E", "Annual P/E at filing dates")
            }
            readout={readout}
            option={(c) => ({
              xAxis:
                mode === "ps"
                  ? {
                      type: "time",
                      axisLabel: {
                        color: c.axis,
                        hideOverlap: true,
                        formatter: (value: number) => formatDate(value, locale, { year: "numeric", month: "short", timeZone: "UTC" }),
                      },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    }
                  : {
                      type: "category",
                      data: rows.map((r) => formatCalendarDate(str(r.priceDate), locale)),
                      axisLabel: { color: c.axis, hideOverlap: true },
                      axisLine: { show: false },
                      axisTick: { show: false },
                    },
              yAxis: {
                type: "value",
                name: ratio + " · ×",
                scale: true,
                axisLabel: { color: c.axis },
              },
              series: [
                {
                  type: mode === "ps" ? "line" : "scatter",
                  symbolSize: 9,
                  data:
                    mode === "ps" ? points : rows.map((r) => numeric(r[mode])),
                  connectNulls: false,
                  itemStyle: { color: c.brand },
                  lineStyle: { color: c.brand },
                },
              ],
            })}
          />
          <EvidenceTable
            label={t("历史估值证据", "Historical valuation evidence")}
            rows={rows}
            columns={[
              { label: t("披露日期", "Filed"), value: (r) => formatCalendarDate(str(r.publishedAt), locale) },
              {
                label: t("收盘日", "Price date"),
                value: (r) => formatCalendarDate(str(r.priceDate), locale),
              },
              {
                label:
                  mode === "ps"
                    ? t("TTM 截至", "TTM ending")
                    : t("年度截至", "FY ending"),
                value: (r) => formatCalendarDate(str(r.periodEnd), locale),
              },
              {
                label:
                  // The P/S · TTM choice and the TTM column beside it state the basis.
                  (mode === "ps" ? t("营收", "Revenue") : "EPS") +
                  " · " +
                  code,
                value: (r) =>
                  mode === "ps" ? compact(r.revenue, locale) : number(r.eps, 2),
                numeric: true,
              },
              {
                label: t("收盘价", "Close"),
                value: (r) => quoteValue(r.price, r.currency),
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
                label: t("原始披露", "Original filing"),
                value: (r) =>
                  safeUrl(str(r.url)) ? (
                    <a
                      href={safeUrl(str(r.url))}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${t("原始披露", "Original filing")} · ${formatCalendarDate(str(r.publishedAt), locale)}`}
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
                            {compact(r.shares, locale)} · {formatCalendarDate(str(r.shareDate), locale)}
                          </p>
                          {objects(r.components).map((o, i) => (
                            <p key={i}>
                              {formatDateSpan(str(o.periodStart), str(o.periodEnd), locale)} ·{" "}
                              {compact(o.value, locale)} {code}{" "}
                              {safeUrl(str(o.url)) && (
                                <a
                                  href={safeUrl(str(o.url))}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`${t("原始披露", "Original filing")} · ${formatDateSpan(str(o.periodStart), str(o.periodEnd), locale)}`}
                                >
                                  ↗ {t("原始披露", "Original filing")}
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
