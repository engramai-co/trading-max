"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Checkbox, Group, Select, TextInput } from "@mantine/core";
import { useState } from "react";
import { compact, currency, number, object, objects, percent, str, type Json } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import {
  statementUnit,
  statementValue,
  trailingStatement,
} from "./financial-values";
import { Empty, Facts, Notice, Panel, Segments, useCopy } from "./foundation";
import {
  orderedStatement,
  relativeToPrice,
  statementOrder,
} from "./research-display";
import { useRouteState } from "./route-state";

export { AnalystView } from "./research-analyst";
export { CompanyOverview } from "./research-overview";
export function TechnicalView({ data }: { data: ResearchLensSnapshot }) {
  const { params, update } = useRouteState("push");
  const t = useCopy(),
    tech = data.technical;
  const benchmark = ["spy", "qqq", "soxx"].includes(
    params.get("technicalBenchmark") ?? "",
  )
    ? params.get("technicalBenchmark")!
    : "spy";
  if (!tech)
    return (
      <Panel>
        <Empty title={t("技术数据尚未就绪", "Technical data is not ready")} />
      </Panel>
    );
  const relative =
    tech.currency === "USD"
      ? object(tech.relativeStrength?.[benchmark + "_63d"])
      : {};
  const more = (title: string, rows: Array<[string, string]>) => (
    <details className="mx-technical-more">
      <summary>{title}</summary>
      <Facts rows={rows} />
    </details>
  );
  const showAverage = (key: string) =>
    update({
      technicalView: null,
      priceRange: "1Y",
      interval: "1d",
      chart: null,
      ma: "on",
      highlightMa: key,
      priceScale: null,
      benchmark: null,
    });
  return (
    <Panel
      title={t("技术数据", "Technical data")}
      action={
        <span className="mx-unit">
          {tech.asOf} · {t("日线", "Daily")} · {tech.currency}
        </span>
      }
      help={t(
        "所有读数按此处日期的调整后日线计算，与页首最近报价可能有时间差。均线为交易日收盘均值；此前 20 日高低点不含当前日。技术读数用于描述价格，不生成买卖建议。",
        "Readings use adjusted daily bars as of this date, which may differ from the latest header quote. Averages use session closes; prior 20-session highs and lows exclude the current bar. Indicators describe prices, not trade recommendations.",
      )}
    >
      <div className="mx-technical-grid">
        <section>
          <h3>{t("表现与位置", "Performance & levels")}</h3>
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
                t("52 周区间", "52-week range"),
                `${number(tech.low52w, 2)} – ${number(tech.high52w, 2)}`,
              ],
              [
                t("距 52 周高点", "From 52-week high"),
                percent(tech.drawdown52w),
              ],
            ]}
          />
          <table className="mx-technical-ma">
            <thead>
              <tr>
                <th>{t("日均线", "Daily SMA")}</th>
                <th>{tech.currency}</th>
                <th>{t("价格偏离", "Distance")}</th>
              </tr>
            </thead>
            <tbody>
              {(["sma20", "sma50", "sma200"] as const).map((key) => (
                <tr key={key}>
                  <th>
                    <button
                      className="mx-text-link"
                      onClick={() => showAverage(key)}
                    >
                      {key.toUpperCase()}
                    </button>
                  </th>
                  <td>{number(tech[key], 2)}</td>
                  <td>
                    {percent(relativeToPrice(tech.price, tech[key]), true, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more(t("更多价格位置", "More price levels"), [
            [t("日线收盘", "Daily close"), number(tech.price, 2)],
            [
              t("此前 20 日低点", "Prior 20-session low"),
              number(tech.support20, 2),
            ],
            [
              t("此前 20 日高点", "Prior 20-session high"),
              number(tech.resistance20, 2),
            ],
          ])}
        </section>
        <section>
          <h3>{t("动量与趋势", "Momentum & trend")}</h3>
          <Facts
            rows={[
              ["RSI · 14", number(tech.rsi, 1)],
              [
                t("MACD 与信号线", "MACD vs signal"),
                tech.macdHistogram == null
                  ? "—"
                  : tech.macdHistogram > 0
                    ? t("高于信号线", "Above signal")
                    : tech.macdHistogram < 0
                      ? t("低于信号线", "Below signal")
                      : t("重合", "Equal"),
              ],
              ["ADX · 14", number(tech.adx, 1)],
            ]}
          />
          {more(t("详细动量读数", "Detailed momentum readings"), [
            ["MACD · 12/26", number(tech.macd, 3)],
            [t("信号线 · 9", "Signal · 9"), number(tech.macdSignal, 3)],
            [t("MACD 差值", "MACD difference"), number(tech.macdHistogram, 3)],
            [
              "+DI / −DI · 14",
              `${number(tech.plusDi, 1)} / ${number(tech.minusDi, 1)}`,
            ],
            [
              t("随机指标 %K · 14", "Stochastic %K · 14"),
              number(tech.stochasticK, 1),
            ],
            [
              t("随机指标 %D · 3", "Stochastic %D · 3"),
              number(tech.stochasticD, 1),
            ],
          ])}
        </section>
        <section>
          <h3>{t("波动", "Volatility")}</h3>
          <Facts
            rows={[
              ["ATR · 14", number(tech.atr, 2)],
              [t("ATR / 价格", "ATR / price"), percent(tech.atrPct)],
              [
                t("布林带位置 %B", "Bollinger %B"),
                percent(tech.bollingerPosition),
              ],
              [
                t("布林带宽度", "Bollinger bandwidth"),
                percent(tech.bollingerWidth),
              ],
            ]}
          />
          {more(
            t("布林带读数 · 20 日 / 2σ", "Bollinger levels · 20 days / 2σ"),
            [
              [t("上轨", "Upper band"), number(tech.bollingerUpper, 2)],
              [t("中轨", "Middle band"), number(tech.sma20, 2)],
              [t("下轨", "Lower band"), number(tech.bollingerLower, 2)],
            ],
          )}
        </section>
        <section>
          <h3>{t("量能与相对表现", "Volume & relative performance")}</h3>
          <Facts
            rows={[
              [t("日成交量", "Session volume"), compact(tech.volume)],
              [
                t("20 日均量", "20-session average volume"),
                compact(tech.averageVolume20d),
              ],
              [
                t("成交量 / 20 日均量", "Volume / 20-session average"),
                tech.relativeVolume20d == null
                  ? "—"
                  : number(tech.relativeVolume20d, 2) + "×",
              ],
            ]}
          />
          <Select
            size="xs"
            aria-label={t("相对表现基准", "Relative performance benchmark")}
            value={benchmark}
            data={[
              { value: "spy", label: "SPY · S&P 500" },
              { value: "qqq", label: "QQQ · Nasdaq 100" },
              { value: "soxx", label: "SOXX · Semiconductors" },
            ]}
            onChange={(v) => update({ technicalBenchmark: v })}
          />
          <Facts
            rows={[
              [
                t("63 日收益差", "63-session return difference"),
                numeric(relative.excess_return) == null
                  ? "—"
                  : number(Number(relative.excess_return) * 100, 2) + " pp",
              ],
            ]}
          />
          {more(t("基准比较明细", "Benchmark comparison details"), [
            [
              t("证券 · 共同区间收益", "Security · common-window return"),
              percent(relative.asset_return, true),
            ],
            [
              t("基准 · 共同区间收益", "Benchmark · common-window return"),
              percent(relative.benchmark_return, true),
            ],
            ["Beta · 63", number(relative.beta, 2)],
            [
              t("相关性 · 63", "Correlation · 63"),
              number(relative.correlation, 2),
            ],
          ])}
          {tech.currency !== "USD" && (
            <small>
              {t(
                "缺少同币种基准记录",
                "Matching-currency benchmark records unavailable",
              )}
            </small>
          )}
        </section>
      </div>
      {!tech.historyCoverage.complete && (
        <Notice tone="warn">
          {t(
            "日线覆盖不足，长周期读数可能缺失。",
            "Limited daily history; some long-period readings may be unavailable.",
          )}
        </Notice>
      )}
      {tech.adrResearch && (
        <details className="mx-chart-data">
          <summary>
            {t("存托凭证数据口径", "Depositary receipt context")}
          </summary>
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
            ]}
          />
        </details>
      )}
    </Panel>
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
export function FinancialStatements({
  data,
  controlledFrequency,
}: {
  data: ResearchLensSnapshot;
  controlledFrequency?: string;
}) {
  const t = useCopy();
  const [statement, setStatement] = useState("incomeStatement");
  const [unit, setUnit] = useState("millions");
  const [growth, setGrowth] = useState(false);
  const [lineFilter, setLineFilter] = useState("");
  const [allLines, setAllLines] = useState(false);
  const [localFrequency, setFrequency] = useState("annual");
  const frequency =
    controlledFrequency === "ttm"
      ? "quarterly"
      : (controlledFrequency ?? localFrequency);
  const originalRows = statementRows(
    data,
    frequency === "annual"
      ? statement
      : "quarterly" + statement[0].toUpperCase() + statement.slice(1),
  );
  const rows =
    controlledFrequency === "ttm"
      ? trailingStatement(originalRows, statement, data.financialFacts)
      : originalRows;
  const dates = statementDates(rows).reverse();
  const periodFor = (date: string) =>
    data.financialFacts?.periods?.find(
      (p) =>
        p.providerEnd === date.slice(0, 10) &&
        p.kind === (controlledFrequency ?? frequency),
    );
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
        "报告期从新到旧。同比仅匹配上一财年同一季度或年度，基数非正或缺失时不计算。TTM 汇总完整四季；资产负债为期末值。",
        "Newest periods first. YoY matches the same fiscal quarter or year; non-positive or missing baselines stay unavailable. TTM sums four quarters; balance-sheet items use the ending value.",
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
          label={t("显示同比变化", "Show year-over-year change")}
          onChange={(e) => setGrowth(e.currentTarget.checked)}
        />
        {!controlledFrequency && (
          <Segments
            label={t("报告频率", "Reporting frequency")}
            value={frequency}
            onChange={setFrequency}
            options={[
              { value: "annual", label: t("年度", "Annual") },
              { value: "quarterly", label: t("季度", "Quarterly") },
            ]}
          />
        )}
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
                      {periodFor(date)?.label ?? date.slice(0, 10)}
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
                    {dates.map((date) => {
                      const currentPeriod = periodFor(date);
                      const priorPeriod = currentPeriod
                        ? data.financialFacts?.periods?.find(
                            (p) =>
                              p.kind === currentPeriod.kind &&
                              p.fiscalYear ===
                                (currentPeriod.fiscalYear ?? 0) - 1 &&
                              p.fiscalQuarter === currentPeriod.fiscalQuarter,
                          )
                        : undefined;
                      const priorDate = priorPeriod
                        ? dates.find(
                            (d) => d.slice(0, 10) === priorPeriod.providerEnd,
                          )
                        : undefined;
                      const previous = priorDate
                        ? numeric(row[priorDate])
                        : null;
                      const current = numeric(row[date]);
                      const change =
                        previous != null && previous > 0 && current != null
                          ? current / previous - 1
                          : null;
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
