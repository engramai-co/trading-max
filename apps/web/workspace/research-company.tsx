"use client";

import {
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import type { ResearchLensSnapshot } from "@/lib/types";
import { useState } from "react";
import { statementUnit, statementValue, quoteValue } from "./financial-values";
import { researchText } from "./research-copy";
import { reportedGrowth } from "./research-math";
import { AnalystExpectations } from "./research-expectations";
import { AnalystEstimates } from "./research-forecasts";
import {
  orderedStatement,
  relativeToPrice,
  statementOrder,
} from "./research-display";
import {
  normalizeRatingRow,
  ratingKeys,
  recommendationChange,
} from "./analyst-data";
import { EvidenceTable } from "./evidence-table";
import { HistoryChart, Legend, Plot } from "./charts";
import {
  compact,
  currency,
  number,
  numeric,
  object,
  objects,
  percent,
  safeUrl,
  str,
  type Json,
} from "./data";
import {
  Empty,
  Facts,
  Metric,
  Notice,
  Panel,
  Segments,
  TextLink,
  useCopy,
} from "./foundation";

export function CompanyOverview({
  data,
  context,
}: {
  data: ResearchLensSnapshot;
  context?: ResearchLensSnapshot;
}) {
  const t = useCopy(),
    market = object(data.market),
    impact = data.portfolioImpact,
    info = context ? metricSource(context) : {};
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {context?.fundamentals && (
        <Panel
          title={t("公司概况", "Company profile")}
          action={
            safeUrl(str(info.website)) ? (
              <a
                className="mx-text-link"
                href={safeUrl(str(info.website))}
                target="_blank"
                rel="noreferrer"
              >
                {t("公司网站", "Company website")} ↗
              </a>
            ) : undefined
          }
        >
          <div className="mx-company-context">
            <div>
              <div className="mx-company-sector">
                {str(info.sector)}
                {info.sector && info.industry ? " / " : ""}
                {str(info.industry)}
              </div>
              {info.longBusinessSummary ? (
                <div className="mx-company-description">
                  <p className={expanded ? undefined : "mx-business-excerpt"}>
                    {str(info.longBusinessSummary)}
                  </p>
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded
                      ? t("收起简介", "Show less")
                      : t("完整业务简介", "Full business description")}
                  </Button>
                </div>
              ) : null}
            </div>
            <Facts
              rows={[
                [
                  t("市值", "Market cap"),
                  compact(info.marketCap) +
                    (info.currency ? " " + str(info.currency) : ""),
                ],
                [
                  t("年营收 · TTM", "Revenue · TTM"),
                  compact(info.totalRevenue) +
                    (info.financialCurrency
                      ? " " + str(info.financialCurrency)
                      : ""),
                ],
                [t("市盈率 · 历史", "Trailing P/E"), number(info.trailingPE)],
                [
                  t("下一财报日", "Next earnings date"),
                  str(
                    (
                      object(object(context.fundamentals).earningsCalendar)
                        .earningsDates as unknown[] | undefined
                    )?.[0],
                  ).slice(0, 10) || "—",
                ],
              ]}
            />
          </div>
        </Panel>
      )}
      <Panel>
        <div className="mx-metric-grid">
          <Metric
            label={t("技术评分", "Technical score")}
            value={
              data.technical ? number(data.technical.score, 0) + " / 100" : "—"
            }
          />
          <Metric
            label={t("五年模型价值", "Five-year model value")}
            value={quoteValue(
              data.valuation?.ev5,
              data.valuation?.currency,
              t("币种未提供", "Currency unavailable"),
            )}
          />
          <Metric
            label={t("分析师目标中位数", "Median analyst target")}
            value={quoteValue(
              market.analystMedian,
              market.currency,
              t("币种未提供", "Currency unavailable"),
            )}
          />
          <Metric
            label={t("企业价值", "Enterprise value")}
            value={compact(market.enterpriseValue)}
            note={str(market.currency)}
          />
        </div>
      </Panel>
      <div className="mx-grid mx-overview-context">
        <Panel title={t("组合敞口", "Portfolio exposure")}>
          {impact ? (
            <>
              <div
                className="mx-metric-grid"
                style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 18 }}
              >
                <Metric
                  label={t("合计敞口", "Total exposure")}
                  value={currency(impact.exposureValueGbp)}
                />
                <Metric
                  label={t("组合权重", "Portfolio weight")}
                  value={percent(impact.allocationPct)}
                />
              </div>
              <Facts
                rows={[
                  [
                    t("直接持有", "Direct holdings"),
                    currency(impact.directValueGbp),
                  ],
                  [
                    t("基金内持有", "Through funds"),
                    currency(impact.indirectValueGbp),
                  ],
                  [
                    t("持有账户", "Holding accounts"),
                    impact.holdingAccounts
                      .map((a) =>
                        a === "A" ? "Invest" : a === "B" ? "ISA" : a,
                      )
                      .join(" · ") || "—",
                  ],
                  [t("国家", "Country"), impact.country ?? "—"],
                  [t("行业", "Industry"), impact.industry ?? "—"],
                ]}
              />
            </>
          ) : (
            <Empty
              title={t("暂无组合敞口", "No portfolio exposure available")}
            />
          )}
        </Panel>
        <Panel title={t("最新研究事件", "Latest research event")}>
          {data.latestEvent ? (
            <article className="mx-timeline-entry">
              <time>{data.latestEvent.asOf}</time>
              <h3>{researchText(data.latestEvent.title, t)}</h3>
              {data.latestEvent.summary && <p>{data.latestEvent.summary}</p>}
              <SourceLinks sources={data.latestEvent.sources} />
            </article>
          ) : (
            <Empty
              title={t("还没有已记录事件", "No recorded events yet")}
              description={t(
                "后续财报与研究更新会在这里留下记录。",
                "Earnings and research updates will appear here as they are recorded.",
              )}
            />
          )}
          <div style={{ marginTop: 22 }}>
            <TextLink
              href={
                "/research?ticker=" +
                encodeURIComponent(data.ticker) +
                "&view=ledger"
              }
            >
              {t("查看完整研究记录", "Read the research journal")}
            </TextLink>
          </div>
        </Panel>
      </div>
      {data.alerts.map((a) => (
        <Notice
          key={a.alertId}
          tone={
            a.severity === "critical"
              ? "bad"
              : a.severity === "warning"
                ? "warn"
                : "neutral"
          }
        >
          <strong>{researchText(a.title, t)}</strong> ·{" "}
          {researchText(a.message, t)}
        </Notice>
      ))}
    </>
  );
}
export function TechnicalView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy(),
    tech = data.technical;
  if (!tech)
    return (
      <Panel>
        <Empty
          title={t("技术观测还未就绪", "Technical observations are not ready")}
          description={t(
            "更新证券研究后，均线、动量和支撑阻力会显示在这里。",
            "Update research to load trend, momentum and price-level observations.",
          )}
        />
      </Panel>
    );
  const ma = [tech.sma20, tech.sma50, tech.sma200];
  return (
    <>
      <div className="mx-grid">
        <Panel
          title={t("趋势摘要", "Trend summary")}
          help={t(
            "综合评分来自趋势与动量模型。各指标是独立读数，评分不代表收益概率。",
            "The composite score comes from the trend and momentum model. Indicator readings are independent; the score is not a return probability.",
          )}
        >
          <div className="mx-trend-summary">
            <strong>{researchText(tech.state, t)}</strong>
            <span>
              {t("技术评分", "Technical score")} <b>{number(tech.score, 0)}</b>{" "}
              / 100
            </span>
          </div>
          <Facts
            rows={[
              [
                t("20 日收益", "20-session return"),
                percent(tech.return20d, true),
              ],
              [
                t("63 日收益", "63-session return"),
                percent(tech.return63d, true),
              ],
              [
                t("距 52 周高点", "From 52-week high"),
                percent(tech.drawdown52w),
              ],
              [t("ATR / 价格", "ATR / price"), percent(tech.atrPct)],
            ]}
          />
          {tech.signals.length > 0 && (
            <ul className="mx-research-signals">
              {tech.signals.map((signal, i) => (
                <li key={i}>{researchText(signal, t)}</li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title={t("均线与价格位置", "Moving averages & price levels")}
          help={t(
            "偏离 = 现价 ÷ 均线 − 1。支撑和阻力取近 20 个交易日的观察值。",
            "Distance is spot ÷ moving average − 1. Support and resistance use the latest 20-session observations.",
          )}
        >
          <div
            className="mx-table-wrap"
            role="region"
            tabIndex={0}
            aria-label={t("均线读数", "Moving average readings")}
          >
            <table className="mx-table">
              <thead>
                <tr>
                  <th scope="col">{t("均线", "Average")}</th>
                  <th scope="col" className="mx-align-right">
                    {tech.currency}
                  </th>
                  <th scope="col" className="mx-align-right">
                    {t("价格偏离", "Price distance")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ma.map((value, index) => {
                  const distance = relativeToPrice(tech.price, value);
                  return (
                    <tr key={index}>
                      <th scope="row">
                        {["SMA 20", "SMA 50", "SMA 200"][index]}
                      </th>
                      <td className="mx-align-right">{number(value, 2)}</td>
                      <td className="mx-align-right">
                        {percent(distance, true, 2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mx-price-levels">
            <div>
              <span>{t("20 日支撑", "20-session support")}</span>
              <strong>{currency(tech.support20, tech.currency, 2)}</strong>
            </div>
            <div>
              <span>{t("20 日阻力", "20-session resistance")}</span>
              <strong>{currency(tech.resistance20, tech.currency, 2)}</strong>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title={t("动量指标", "Momentum indicators")}>
        <div className="mx-metric-grid">
          <Metric
            label="RSI · 14"
            value={number(tech.rsi, 1)}
            note={
              tech.rsi == null
                ? undefined
                : tech.rsi >= 70
                  ? t("超买区间", "Overbought range")
                  : tech.rsi <= 30
                    ? t("超卖区间", "Oversold range")
                    : t("中性区间", "Neutral range")
            }
            help={t(
              "RSI 范围为 0–100，30 以下与 70 以上常用作超卖/超买参考，不是反转保证。",
              "RSI ranges from 0–100. Below 30 and above 70 are common oversold/overbought references, not guaranteed reversals.",
            )}
          />
          <Metric label="MACD" value={number(tech.macd, 3)} />
          <Metric
            label={t("MACD 信号线", "MACD signal")}
            value={number(tech.macdSignal, 3)}
          />
          <Metric
            label={t("MACD 差值", "MACD histogram")}
            value={number(tech.macdHistogram, 3)}
            help={t(
              "MACD 与信号线之差。正负表示两者的位置关系。",
              "The difference between MACD and its signal line. The sign describes their relative position.",
            )}
          />
        </div>
      </Panel>
      {!tech.historyCoverage.complete && (
        <Notice tone="warn">
          {tech.historyCoverage.warning ||
            t(
              "价格历史覆盖不完整，长周期指标可能无法计算。",
              "Price history is incomplete; long-period indicators may be unavailable.",
            )}
        </Notice>
      )}
      {tech.adrResearch && (
        <Panel title={t("存托凭证数据口径", "Depositary receipt context")}>
          <Facts
            rows={[
              [
                t("原股代码", "Primary listing"),
                tech.adrResearch.primaryTicker,
              ],
              [
                t("每份 ADR 对应原股", "Ordinary shares per ADR"),
                number(tech.adrResearch.ordinarySharesPerAdr),
              ],
              [
                t("平价价值", "Parity value"),
                currency(tech.adrResearch.parityUsd, "USD", 2),
              ],
              [
                t("相对平价溢价", "Premium to parity"),
                percent(tech.adrResearch.premiumToParity),
              ],
              [t("存托机构", "Depositary"), tech.adrResearch.depositary ?? "—"],
            ]}
          />
        </Panel>
      )}
    </>
  );
}
function metricSource(data: ResearchLensSnapshot): Json {
  const f = object(data.fundamentals);
  return {
    ...f,
    ...object(f.metrics),
    ...object(f.info),
    currency: f.currency ?? object(f.info).currency,
  };
}
function statementRows(data: ResearchLensSnapshot, key: string) {
  return objects(object(data.financials)[key]);
}
function statementDates(rows: Json[]) {
  return [
    ...new Set(
      rows.flatMap((r) =>
        Object.keys(r).filter((k) => /^\d{4}-\d{2}-\d{2}/.test(k)),
      ),
    ),
  ].sort();
}
function financialRow(rows: Json[], name: string) {
  return (
    rows.find(
      (r) =>
        String(r.index ?? r.name ?? "").toLowerCase() === name.toLowerCase(),
    ) ?? {}
  );
}
export function FundamentalsView({ data }: { data: ResearchLensSnapshot }) {
  const [frequency, setFrequency] = useState("annual");
  const [measure, setMeasure] = useState("amount");
  const t = useCopy(),
    info = metricSource(data);
  const rows = statementRows(
    data,
    frequency === "annual" ? "incomeStatement" : "quarterlyIncomeStatement",
  );
  const revenue = financialRow(rows, "Total Revenue"),
    net = financialRow(rows, "Net Income"),
    gross = financialRow(rows, "Gross Profit"),
    operating = financialRow(rows, "Operating Income");
  const dates = statementDates(rows).filter((date) =>
    [revenue, net, gross, operating].some((row) => numeric(row[date]) != null),
  );
  const code = str(info.financialCurrency);
  const margin = (row: Json, date: string) =>
    numeric(revenue[date]) != null &&
    Number(revenue[date]) > 0 &&
    numeric(row[date]) != null
      ? Number(row[date]) / Number(revenue[date])
      : null;
  if (!data.fundamentals)
    return (
      <Panel>
        <Empty
          title={t("经营数据暂不可用", "Business fundamentals unavailable")}
        />
      </Panel>
    );
  return (
    <>
      <Panel>
        <div className="mx-metric-grid">
          <Metric
            label={t("营收 · TTM", "Revenue · TTM")}
            value={compact(info.totalRevenue)}
            note={code || t("币种未提供", "Currency unavailable")}
          />
          <Metric
            label={t("营收同比", "Revenue YoY")}
            value={percent(info.revenueGrowth, true)}
          />
          <Metric
            label={t("盈利同比", "Earnings YoY")}
            value={percent(info.earningsGrowth, true)}
          />
          <Metric
            label={t("自由现金流", "Free cash flow")}
            value={compact(info.freeCashflow)}
            note={code || t("币种未提供", "Currency unavailable")}
          />
        </div>
      </Panel>
      <Panel
        title={t("经营趋势", "Operating performance")}
        description={
          measure === "margin"
            ? "%"
            : code || t("币种未提供", "Currency unavailable")
        }
        action={
          <Group gap="sm">
            <Segments
              label={t("财务趋势指标", "Financial trend measure")}
              value={measure}
              onChange={setMeasure}
              options={[
                { value: "amount", label: t("收入与利润", "Revenue & profit") },
                { value: "margin", label: t("利润率", "Margins") },
              ]}
            />
            <Segments
              label={t("财务趋势频率", "Financial trend frequency")}
              value={frequency}
              onChange={setFrequency}
              options={[
                { value: "annual", label: t("年度", "Annual") },
                { value: "quarterly", label: t("季度", "Quarterly") },
              ]}
            />
          </Group>
        }
      >
        {dates.length ? (
          <>
            <Plot
              label={
                measure === "margin"
                  ? t("历年利润率", "Historical margins")
                  : t("营收与净利润", "Revenue and net income")
              }
              option={(c) => ({
                xAxis: {
                  type: "category",
                  data: dates.map((d) =>
                    frequency === "annual" ? d.slice(0, 4) : d.slice(0, 10),
                  ),
                  axisTick: { show: false },
                  axisLine: { show: false },
                  axisLabel: { color: c.axis },
                },
                yAxis: {
                  type: "value",
                  axisLabel: {
                    color: c.axis,
                    formatter: (v: number) =>
                      measure === "margin" ? percent(v) : compact(v),
                  },
                  splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                },
                tooltip: {
                  valueFormatter: (value) =>
                    measure === "margin"
                      ? percent(value, false, 2)
                      : number(value, 0) + (code ? " " + code : ""),
                },
                series:
                  measure === "margin"
                    ? [
                        {
                          name: t("毛利率", "Gross margin"),
                          row: gross,
                          color: c.brand,
                        },
                        {
                          name: t("营业利润率", "Operating margin"),
                          row: operating,
                          color: c.secondary,
                        },
                        {
                          name: t("净利率", "Net margin"),
                          row: net,
                          color: c.accent,
                        },
                      ].map((item) => ({
                        type: "line",
                        name: item.name,
                        data: dates.map((date) => margin(item.row, date)),
                        symbolSize: 6,
                        lineStyle: { color: item.color, width: 2 },
                        itemStyle: { color: item.color },
                        connectNulls: false,
                      }))
                    : [
                        {
                          type: "bar",
                          name: t("营收", "Revenue"),
                          data: dates.map((date) => numeric(revenue[date])),
                          itemStyle: {
                            color: c.brand,
                            borderRadius: [3, 3, 0, 0],
                          },
                          barMaxWidth: 38,
                        },
                        {
                          type: "bar",
                          name: t("净利润", "Net income"),
                          data: dates.map((date) => numeric(net[date])),
                          itemStyle: {
                            color: c.accent,
                            borderRadius: [3, 3, 0, 0],
                          },
                          barMaxWidth: 38,
                        },
                      ],
              })}
            />
            <Legend
              items={
                measure === "margin"
                  ? [
                      {
                        label: t("毛利率", "Gross margin"),
                        colour: "var(--mx-chart-0)",
                      },
                      {
                        label: t("营业利润率", "Operating margin"),
                        colour: "var(--mx-chart-2)",
                      },
                      {
                        label: t("净利率", "Net margin"),
                        colour: "var(--mx-chart-1)",
                      },
                    ]
                  : [
                      { label: t("营收", "Revenue") },
                      { label: t("净利润", "Net income") },
                    ]
              }
            />
            <details className="mx-chart-data">
              <summary>{t("报告期明细", "Reported values")}</summary>
              <EvidenceTable
                label={
                  t("经营历史", "Operating history") +
                  " · " +
                  (code || t("币种未提供", "Currency unavailable"))
                }
                rows={[...dates].reverse()}
                columns={[
                  { label: t("报告期", "Period"), value: (date) => date },
                  {
                    label: t("营收", "Revenue"),
                    value: (date) => number(revenue[date], 0),
                    numeric: true,
                  },
                  {
                    label: t("毛利润", "Gross profit"),
                    value: (date) => number(gross[date], 0),
                    numeric: true,
                  },
                  {
                    label: t("营业利润", "Operating income"),
                    value: (date) => number(operating[date], 0),
                    numeric: true,
                  },
                  {
                    label: t("净利润", "Net income"),
                    value: (date) => number(net[date], 0),
                    numeric: true,
                  },
                  {
                    label: t("净利率", "Net margin"),
                    value: (date) => percent(margin(net, date)),
                    numeric: true,
                  },
                ]}
              />
            </details>
          </>
        ) : (
          <Empty
            title={t(
              "缺少可比较的报告期",
              "Comparable reporting periods are missing",
            )}
          />
        )}
      </Panel>
      <div className="mx-grid">
        <Panel title={t("盈利能力", "Profitability")}>
          <Facts
            rows={[
              [t("毛利率", "Gross margin"), percent(info.grossMargins)],
              [
                t("营业利润率", "Operating margin"),
                percent(info.operatingMargins),
              ],
              [t("净利率", "Net margin"), percent(info.profitMargins)],
            ]}
          />
        </Panel>
        <Panel
          title={t("资本回报", "Returns on capital")}
          help={t(
            "ROE 衡量净利润相对股东权益的比例，ROA 衡量净利润相对资产的比例。",
            "ROE measures net income relative to equity; ROA measures net income relative to assets.",
          )}
        >
          <Facts
            rows={[
              [
                t("净资产收益率 · ROE", "Return on equity · ROE"),
                percent(info.returnOnEquity),
              ],
              [
                t("资产收益率 · ROA", "Return on assets · ROA"),
                percent(info.returnOnAssets),
              ],
            ]}
          />
        </Panel>
      </div>
      <Panel
        title={t("财务状况", "Financial position")}
        help={t(
          "现金、债务与现金流使用报表币种。债务权益比按提供商的百分比单位展示，不同行业的比率不宜直接比较。",
          "Cash, debt and cash flows use the reporting currency. Debt/equity uses the provider's percentage unit. Ratios are not directly comparable across industries.",
        )}
      >
        <div className="mx-grid">
          <Facts
            rows={[
              [
                t("总现金", "Total cash"),
                compact(info.totalCash) + (code ? " " + code : ""),
              ],
              [
                t("总债务", "Total debt"),
                compact(info.totalDebt) + (code ? " " + code : ""),
              ],
              [
                t("经营现金流", "Operating cash flow"),
                compact(info.operatingCashflow) + (code ? " " + code : ""),
              ],
            ]}
          />
          <Facts
            rows={[
              [t("流动比率", "Current ratio"), number(info.currentRatio)],
              [t("速动比率", "Quick ratio"), number(info.quickRatio)],
              [
                t("债务 / 权益", "Debt / equity"),
                numeric(info.debtToEquity) == null
                  ? "—"
                  : number(info.debtToEquity, 1) + "%",
              ],
            ]}
          />
        </div>
      </Panel>
    </>
  );
}
const statementNames: Record<string, [string, string]> = {
  "Total Revenue": ["营业收入", "Total revenue"],
  "Operating Revenue": ["主营收入", "Operating revenue"],
  "Cost Of Revenue": ["营业成本", "Cost of revenue"],
  "Gross Profit": ["毛利润", "Gross profit"],
  "Operating Income": ["营业利润", "Operating income"],
  "Operating Expense": ["营业费用", "Operating expenses"],
  "Selling General And Administration": [
    "销售及管理费用",
    "Selling, general & administrative",
  ],
  "Pretax Income": ["税前利润", "Pretax income"],
  "Net Income": ["净利润", "Net income"],
  EBITDA: ["EBITDA", "EBITDA"],
  EBIT: ["EBIT", "EBIT"],
  "Diluted EPS": ["摊薄每股收益", "Diluted EPS"],
  "Basic EPS": ["基本每股收益", "Basic EPS"],
  "Basic Average Shares": ["基本加权平均股数", "Basic weighted average shares"],
  "Diluted Average Shares": [
    "摊薄加权平均股数",
    "Diluted weighted average shares",
  ],
  "Total Assets": ["总资产", "Total assets"],
  "Current Assets": ["流动资产", "Current assets"],
  "Cash Cash Equivalents And Short Term Investments": [
    "现金、等价物及短期投资",
    "Cash, equivalents & short-term investments",
  ],
  Receivables: ["应收款项", "Receivables"],
  Inventory: ["存货", "Inventory"],
  "Total Non Current Assets": ["非流动资产", "Non-current assets"],
  "Net PPE": ["固定资产净额", "Property, plant & equipment, net"],
  "Goodwill And Other Intangible Assets": [
    "商誉及其他无形资产",
    "Goodwill & other intangible assets",
  ],
  "Total Liabilities Net Minority Interest": ["总负债", "Total liabilities"],
  "Current Liabilities": ["流动负债", "Current liabilities"],
  "Current Debt": ["短期债务", "Current debt"],
  "Total Non Current Liabilities Net Minority Interest": [
    "非流动负债",
    "Non-current liabilities",
  ],
  "Long Term Debt": ["长期债务", "Long-term debt"],
  "Stockholders Equity": ["股东权益", "Stockholders equity"],
  "Cash And Cash Equivalents": ["现金及等价物", "Cash and cash equivalents"],
  "Total Debt": ["总债务", "Total debt"],
  "Net Debt": ["净债务", "Net debt"],
  "Working Capital": ["营运资本", "Working capital"],
  "Operating Cash Flow": ["经营现金流", "Operating cash flow"],
  "Net Income From Continuing Operations": [
    "持续经营净利润",
    "Net income from continuing operations",
  ],
  "Depreciation And Amortization": [
    "折旧及摊销",
    "Depreciation & amortization",
  ],
  "Stock Based Compensation": ["股权激励费用", "Stock-based compensation"],
  "Change In Working Capital": ["营运资本变动", "Change in working capital"],
  "Investing Cash Flow": ["投资现金流", "Investing cash flow"],
  "Purchase Of Investment": ["购入投资", "Investment purchases"],
  "Sale Of Investment": ["出售投资", "Investment sales"],
  "Financing Cash Flow": ["融资现金流", "Financing cash flow"],
  "Common Stock Dividend Paid": ["普通股股息支付", "Common dividends paid"],
  "Repurchase Of Capital Stock": ["股份回购", "Share repurchases"],
  "Net Issuance Payments Of Debt": [
    "债务净发行及偿还",
    "Net debt issuance / repayments",
  ],
  "Changes In Cash": ["现金变动", "Change in cash"],
  "Beginning Cash Position": ["期初现金", "Beginning cash"],
  "End Cash Position": ["期末现金", "Ending cash"],
  "Free Cash Flow": ["自由现金流", "Free cash flow"],
  "Capital Expenditure": ["资本开支", "Capital expenditure"],
  "Research And Development": ["研发费用", "Research and development"],
  "Interest Expense": ["利息费用", "Interest expense"],
  "Tax Provision": ["所得税费用", "Tax provision"],
  "Tax Rate For Calcs": ["有效税率", "Effective tax rate"],
};
export function FinancialStatements({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [statement, setStatement] = useState("incomeStatement");
  const [unit, setUnit] = useState("millions");
  const [growth, setGrowth] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const [allLines, setAllLines] = useState(false);
  const [frequency, setFrequency] = useState("annual");
  const rows = statementRows(
      data,
      frequency === "annual"
        ? statement
        : "quarterly" + statement[0].toUpperCase() + statement.slice(1),
    ),
    dates = statementDates(rows).reverse();
  const reportCurrency = str(metricSource(data).financialCurrency);
  const unitLabel = reportCurrency || t("币种未提供", "Currency unavailable");
  const label = (row: Json) => {
    const raw = str(row.index ?? row.name);
    const pair = statementNames[raw];
    const name = pair ? t(pair[0], pair[1]) : raw;
    const kind = statementUnit(raw);
    return (
      name +
      (kind === "per-share"
        ? " · " + unitLabel + t("/股", "/share")
        : kind === "shares"
          ? " · " +
            (unit === "millions"
              ? t("百万股", "million shares")
              : t("股", "shares"))
          : "")
    );
  };
  const format = (value: unknown, name: string) =>
    statementValue(value, name, unit === "millions");
  const primaryNames = statementOrder[statement] ?? [];
  const hasPrimary = rows.some((row) =>
    primaryNames.includes(str(row.index ?? row.name)),
  );
  const visibleRows = orderedStatement(rows, statement).filter((row) => {
    const search = lineFilter.trim().toLowerCase();
    if (search)
      return (label(row) + " " + str(row.index ?? row.name))
        .toLowerCase()
        .includes(search);
    return (
      allLines ||
      !hasPrimary ||
      primaryNames.includes(str(row.index ?? row.name))
    );
  });
  return (
    <Panel
      title={t("财务报表", "Financial statements")}
      help={t(
        "报告期从新到旧。变化率为相邻期差额除以上期绝对值；上期为零或缺失时不计算。",
        "Newest periods first. Change is the difference divided by the absolute previous value; zero or missing baselines stay unavailable.",
      )}
    >
      <div className="mx-toolbar" style={{ marginBottom: 24 }}>
        <Segments
          label={t("报表类型", "Statement type")}
          value={statement}
          onChange={setStatement}
          options={[
            { value: "incomeStatement", label: t("利润表", "Income") },
            { value: "balanceSheet", label: t("资产负债表", "Balance sheet") },
            { value: "cashflow", label: t("现金流量表", "Cash flow") },
          ]}
        />
        <Select
          aria-label={t("报表显示单位", "Statement display units")}
          value={unit}
          onChange={(v) => setUnit(v ?? "millions")}
          w={210}
          data={[
            { value: "millions", label: t("百万 ", "Millions · ") + unitLabel },
            {
              value: "original",
              label: t("原始金额 · ", "Original · ") + unitLabel,
            },
          ]}
        />
      </div>
      <Group mb="lg" justify="space-between">
        <Checkbox
          checked={growth}
          label={t("显示相邻期变化", "Show change from previous period")}
          onChange={(e) => setGrowth(e.currentTarget.checked)}
        />
        <Segments
          label={t("报告频率", "Reporting frequency")}
          value={frequency}
          onChange={setFrequency}
          options={[
            { value: "annual", label: t("年度", "Annual") },
            { value: "quarterly", label: t("季度", "Quarterly") },
          ]}
        />
      </Group>
      <div className="mx-toolbar mx-statement-filter">
        <TextInput
          aria-label={t("查找报表科目", "Find a statement line")}
          placeholder={t("查找科目…", "Find a line item…")}
          value={lineFilter}
          onChange={(e) => setLineFilter(e.currentTarget.value)}
        />
        <Checkbox
          checked={allLines}
          onChange={(e) => setAllLines(e.currentTarget.checked)}
          label={t("全部明细", "All line items")}
        />
      </div>
      {rows.length && dates.length ? (
        <>
          <div
            className="mx-table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("数据表格", "Data table")}
          >
            <table className="mx-table mx-statements">
              <thead>
                <tr>
                  <th>{t("会计科目", "Line item")}</th>
                  {dates.map((date) => (
                    <th className="mx-align-right" key={date}>
                      {date.slice(0, 10)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!visibleRows.length && (
                  <tr>
                    <td colSpan={dates.length + 1}>
                      {t("没有匹配的科目", "No matching line items")}
                    </td>
                  </tr>
                )}
                {visibleRows.map((row, i) => (
                  <tr key={i}>
                    <th scope="row" title={str(row.index ?? row.name)}>
                      {label(row)}
                    </th>
                    {dates.map((date, index) => {
                      const previous = numeric(row[dates[index + 1]]),
                        current = numeric(row[date]);
                      const change = reportedGrowth(current, previous);
                      return (
                        <td key={date} className="mx-align-right">
                          {format(row[date], str(row.index ?? row.name))}
                          {growth && change != null && (
                            <small>{percent(change, true, 1)}</small>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty
          title={t(
            "这份报表暂时没有可用记录",
            "This statement has no available records",
          )}
          description={t(
            "数据源覆盖可能因证券与报告期而不同。",
            "Provider coverage can differ by security and reporting period.",
          )}
        />
      )}
    </Panel>
  );
}
function periodLabel(value: unknown, t: (zh: string, en: string) => string) {
  const key = str(value);
  const map: Record<string, string> = {
    "0q": t("本季度", "Current quarter"),
    "+1q": t("下季度", "Next quarter"),
    "0y": t("本财年", "Current year"),
    "+1y": t("下财年", "Next year"),
    "0m": t("本月", "Current month"),
    "-1m": t("上月", "Last month"),
    LTG: t("长期增长", "Long-term growth"),
  };
  const monthsAgo = /^-\d+m$/.test(key) ? Math.abs(parseInt(key)) : null;
  return (
    map[key] ??
    (monthsAgo != null ? monthsAgo + t(" 个月前", " months ago") : key)
  );
}
export function AnalystView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy(),
    a = object(data.analyst),
    history = objects(a.earningsHistory),
    recommendations = objects(a.recommendations).map(normalizeRatingRow),
    code = str(object(data.market).currency);
  const quote = (value: unknown) =>
    quoteValue(value, code, t("币种未提供", "Currency unavailable"));
  if (!data.analyst)
    return (
      <Panel>
        <Empty
          title={t("暂无分析师覆盖数据", "Analyst coverage is unavailable")}
          description={t(
            "该证券暂无分析师一致预期。",
            "No analyst consensus is available for this security.",
          )}
        />
      </Panel>
    );
  const changes = objects(a.upgradesDowngrades)
    .map(recommendationChange)
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <AnalystExpectations data={data} />
      <Panel
        title={t("每股收益：预期与实际", "EPS: estimates & results")}
        description={code || undefined}
      >
        {history.length ? (
          <>
            <Plot
              label={t("每股收益预期与实际", "Estimated and reported EPS")}
              option={(c) => ({
                xAxis: {
                  type: "category",
                  data: history.map((r) =>
                    str(r.quarter ?? r.index).slice(0, 10),
                  ),
                  axisLabel: { color: c.axis },
                  axisTick: { show: false },
                  axisLine: { show: false },
                },
                yAxis: {
                  type: "value",
                  axisLabel: { color: c.axis },
                  splitLine: { lineStyle: { color: c.grid } },
                },
                series: [
                  {
                    type: "bar",
                    name: t("预期", "Estimate"),
                    data: history.map((r) => numeric(r.epsEstimate)),
                    itemStyle: { color: c.accent },
                    barMaxWidth: 18,
                  },
                  {
                    type: "bar",
                    name: t("实际", "Reported"),
                    data: history.map((r) => numeric(r.epsActual)),
                    itemStyle: { color: c.brand },
                    barMaxWidth: 18,
                  },
                ],
              })}
            />
            <Legend
              items={[
                { label: t("实际", "Reported") },
                { label: t("预期", "Estimate") },
              ]}
            />
          </>
        ) : (
          <Empty
            title={t("暂无可比较的财报记录", "No comparable earnings reports")}
          />
        )}
        <details className="mx-chart-data">
          <summary>
            {t("财报明细与惊喜幅度", "Earnings details & surprises")}
          </summary>
          <EvidenceTable
            label={t("实际与预期", "Actual versus expected")}
            rows={history}
            columns={[
              {
                label: t("报告期", "Period"),
                value: (r) => str(r.quarter ?? r.index).slice(0, 10),
              },
              {
                label: t("实际 EPS", "Actual EPS"),
                value: (r) => quote(r.epsActual),
                numeric: true,
              },
              {
                label: t("预期 EPS", "Expected EPS"),
                value: (r) => quote(r.epsEstimate),
                numeric: true,
              },
              {
                label: t("惊喜幅度", "Surprise"),
                value: (r) => percent(r.surprisePercent, true),
                numeric: true,
              },
            ]}
          />
        </details>
      </Panel>
      <Panel title={t("评级历史", "Recommendation history")}>
        {recommendations.length > 0 && (
          <Plot
            label={t(
              "分析师评级随时间变化",
              "Analyst recommendations over time",
            )}
            option={(c) => ({
              xAxis: {
                type: "category",
                data: [...recommendations]
                  .reverse()
                  .map((r) => periodLabel(r.period ?? r.index, t)),
                axisLabel: { color: c.axis },
              },
              yAxis: {
                type: "value",
                minInterval: 1,
                axisLabel: { color: c.axis },
              },
              grid: { top: 20, right: 18, bottom: 72, left: 58 },
              legend: {
                type: "scroll",
                bottom: 0,
                left: 12,
                right: 12,
                textStyle: { color: c.text },
                pageTextStyle: { color: c.text },
              },
              series: ["strongBuy", "buy", "hold", "underperform", "sell"].map(
                (key, index) => ({
                  type: "bar",
                  stack: "ratings",
                  itemStyle: {
                    color: [
                      c.positive,
                      c.secondary,
                      c.warning,
                      c.accent,
                      c.negative,
                    ][index],
                  },
                  name: [
                    t("强烈买入", "Strong buy"),
                    t("买入", "Buy"),
                    t("持有", "Hold"),
                    t("弱于大市", "Underperform"),
                    t("卖出", "Sell"),
                  ][index],
                  data: [...recommendations]
                    .reverse()
                    .map((r) => numeric(r[key])),
                  barMaxWidth: 40,
                }),
              ),
            })}
          />
        )}
        <details className="mx-chart-data">
          <summary>{t("评级数量明细", "Rating count details")}</summary>
          <EvidenceTable
            label={t("评级数量历史", "Historical rating counts")}
            rows={recommendations}
            columns={[
              {
                label: t("覆盖期", "Period"),
                value: (r) => periodLabel(r.period ?? r.index, t),
              },
              ...["strongBuy", "buy", "hold", "underperform", "sell"].map(
                (key) => ({
                  label: [
                    t("强烈买入", "Strong buy"),
                    t("买入", "Buy"),
                    t("持有", "Hold"),
                    t("弱于大市", "Underperform"),
                    t("卖出", "Sell"),
                  ][ratingKeys.indexOf(key as (typeof ratingKeys)[number])],
                  value: (r: Json) => number(r[key], 0),
                  numeric: true,
                }),
              ),
            ]}
          />
        </details>
      </Panel>
      <AnalystEstimates data={data} />
      {objects(a.epsTrend).length > 0 && (
        <Panel
          title={t("盈利预期如何变化", "How EPS expectations have changed")}
        >
          <div
            className="mx-table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("数据表格", "Data table")}
          >
            <table className="mx-table">
              <thead>
                <tr>
                  <th>{t("报告期", "Period")}</th>
                  {[
                    t("90 天前", "90 days ago"),
                    t("30 天前", "30 days ago"),
                    t("7 天前", "7 days ago"),
                    t("当前", "Current"),
                  ].map((label) => (
                    <th key={label} className="mx-align-right">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {objects(a.epsTrend).map((r, i) => (
                  <tr key={i}>
                    <td>{periodLabel(r.index ?? r.period, t)}</td>
                    {["90daysAgo", "30daysAgo", "7daysAgo", "current"].map(
                      (key) => (
                        <td key={key} className="mx-align-right">
                          {currency(r[key], code, 2)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {[
        {
          title: t("盈利预期修订", "EPS estimate revisions"),
          rows: objects(a.epsRevisions),
          fields: [
            { key: "upLast7days", label: t("7 天上修", "Up, 7 days") },
            { key: "upLast30days", label: t("30 天上修", "Up, 30 days") },
            { key: "downLast7Days", label: t("7 天下修", "Down, 7 days") },
            { key: "downLast30days", label: t("30 天下修", "Down, 30 days") },
          ],
          ratio: false,
        },
        {
          title: t("增长预期对照", "Growth expectations in context"),
          rows: objects(a.growthEstimates),
          fields: [
            { key: "stockTrend", label: t("公司", "Company") },
            { key: "industryTrend", label: t("行业", "Industry") },
            { key: "sectorTrend", label: t("板块", "Sector") },
            { key: "indexTrend", label: t("指数", "Index") },
          ],
          ratio: true,
        },
      ]
        .map((group) => ({
          ...group,
          fields: group.fields.filter((field) =>
            group.rows.some((row) => numeric(row[field.key]) != null),
          ),
        }))
        .filter((group) => group.rows.length)
        .map((group) => (
          <Panel key={group.title} title={group.title}>
            <div
              className="mx-table-wrap"
              tabIndex={0}
              role="region"
              aria-label={t("数据表格", "Data table")}
            >
              <table className="mx-table">
                <thead>
                  <tr>
                    <th>{t("报告期", "Period")}</th>
                    {group.fields.map((field) => (
                      <th key={field.key} className="mx-align-right">
                        {field.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, i) => (
                    <tr key={i}>
                      <td>{periodLabel(row.index ?? row.period, t)}</td>
                      {group.fields.map((field) => (
                        <td key={field.key} className="mx-align-right">
                          {group.ratio
                            ? percent(row[field.key], true)
                            : number(row[field.key], 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      {changes.length > 0 && (
        <Panel title={t("最近评级调整", "Recent recommendation changes")}>
          <EvidenceTable
            label={t("机构评级调整", "Institutional rating changes")}
            rows={changes}
            columns={[
              {
                label: t("日期", "Date"),
                value: (r) => r.date || "—",
              },
              {
                label: t("机构", "Firm"),
                value: (r) => r.firm || "—",
              },
              {
                label: t("评级变化", "Rating change"),
                value: (r) => (r.from || "—") + " → " + (r.to || "—"),
              },
              {
                label: t("动作", "Action"),
                value: (r) =>
                  ({
                    up: t("上调", "Upgrade"),
                    down: t("下调", "Downgrade"),
                    main: t("维持", "Maintained"),
                    init: t("首次覆盖", "Initiated"),
                    reit: t("重申", "Reiterated"),
                  })[r.action] ||
                  r.action ||
                  "—",
              },
              {
                label: t("目标价", "Target"),
                value: (r) =>
                  r.target != null && r.target > 0 ? quote(r.target) : "—",
                numeric: true,
              },
            ]}
          />
        </Panel>
      )}
    </>
  );
}
export function SourceLinks({
  sources,
}: {
  sources: Array<Record<string, string>>;
}) {
  return (
    <div className="mx-source-links">
      {sources
        .filter((s) => safeUrl(s.url))
        .map((source, i) => (
          <a
            href={safeUrl(source.url)}
            key={i}
            target="_blank"
            rel="noreferrer"
          >
            {source.name} ↗
          </a>
        ))}
    </div>
  );
}
export function ResearchLedger({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const models = [...data.models].sort((a, b) =>
    a.generatedAt.localeCompare(b.generatedAt),
  );
  const codes = [...new Set(models.map((model) => str(model.values.currency)))];

  return (
    <>
      {data.alerts.length > 0 && (
        <Panel title={t("研究动态", "Research updates")}>
          <Stack gap="sm">
            {data.alerts.map((a) => (
              <Notice
                key={a.alertId}
                tone={
                  a.severity === "critical"
                    ? "bad"
                    : a.severity === "warning"
                      ? "warn"
                      : "neutral"
                }
              >
                <strong>{researchText(a.title, t)}</strong>
                <p>{researchText(a.message, t)}</p>
                <span className="mx-form-help">{a.asOf}</span>
              </Notice>
            ))}
          </Stack>
        </Panel>
      )}
      <Panel title={t("事件与证据", "Events & evidence")}>
        {data.events.length ? (
          <div className="mx-timeline">
            {data.events.map((e, i) => (
              <article key={e.asOf + i} className="mx-timeline-entry">
                <time>{e.asOf}</time>
                <h3>{researchText(e.title, t)}</h3>
                {e.summary && <p>{e.summary}</p>}
                <SourceLinks sources={e.sources} />
              </article>
            ))}
          </div>
        ) : (
          <Empty title={t("尚未记录研究事件", "No research events recorded")} />
        )}
      </Panel>
      <Panel
        title={t("模型记录", "Model history")}
        help={t(
          "按模型运行时间保留估值与假设版本。数据日期是该次模型使用的行情日期。",
          "Valuations and assumption versions are retained by model run. The data date identifies the market observations used by that run.",
        )}
      >
        {codes.map((code) => {
          const matching = models.filter(
            (model) => str(model.values.currency) === code,
          );
          return matching.length >= 3 && code ? (
            <div key={code}>
              <HistoryChart
                label={
                  t("模型估值历史", "Model valuation history") + " · " + code
                }
                dates={matching.map((model) => model.generatedAt)}
                lines={[
                  {
                    name: t("五年模型价值", "Five-year model value"),
                    values: matching.map((model) => numeric(model.values.ev5)),
                  },
                  {
                    name: t("十年模型价值", "Ten-year model value"),
                    values: matching.map((model) => numeric(model.values.ev10)),
                    dashed: true,
                    colour: "accent",
                  },
                ]}
                height={220}
              />
            </div>
          ) : null;
        })}
        <EvidenceTable
          label={t("估值记录", "Valuation records")}
          rows={[...models].reverse()}
          columns={[
            {
              label: t("记录日期", "Run date"),
              value: (model) => model.generatedAt.slice(0, 10),
            },
            {
              label: t("数据日期", "Data date"),
              value: (model) => model.dataAsOf || "—",
            },
            {
              label: t("五年价值", "5-year value"),
              numeric: true,
              value: (model) =>
                quoteValue(
                  model.values.ev5,
                  model.values.currency,
                  t("币种未提供", "Currency unavailable"),
                ),
            },
            {
              label: t("十年价值", "10-year value"),
              numeric: true,
              value: (model) =>
                quoteValue(
                  model.values.ev10,
                  model.values.currency,
                  t("币种未提供", "Currency unavailable"),
                ),
            },
            {
              label: t("五年空间", "5-year upside"),
              numeric: true,
              value: (model) => percent(model.values.ev5Upside, true),
            },
            {
              label: t("模型版本", "Model version"),
              value: (model) => model.modelVersion || "—",
            },
          ]}
        />
      </Panel>
    </>
  );
}
