"use client";
import { useLocale, type Locale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateSpan } from "@/ui/formatters";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { Button, Modal, MultiSelect, Pill, Select } from "@mantine/core";
import { useQueries } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";
import { Plot } from "./charts";
import { number, object, percent } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import type { Reading, ReadingItem, ReadingKey } from "./chart-readout";
import { Empty, Panel, Pending, Segments, useCopy } from "./foundation";
import { factIndex, metricNames } from "./research-facts";
import { researchLensQuery, researchPriceQuery } from "./research-queries";
import { bridgeReadout, minus, readingTone } from "./readout-bridge";
import { useRouteState } from "./route-state";

/**
 * Up to four lines: the researched company in cobalt, the others in ink and grey, solid or dashed.
 * The legend swatch, the hover dot and the reading key all take the line's own stroke from here.
 */
const COMPARE_LINES = [
  { colour: "brand", dashed: false, width: 2 },
  { colour: "text", dashed: true, width: 1.6 },
  { colour: "axis", dashed: false, width: 1.6 },
  { colour: "axis", dashed: true, width: 1.6 },
] as const satisfies ReadonlyArray<{ colour: keyof ChartColours; dashed: boolean; width: number }>;

export function compareStroke(colours: ChartColours, index: number) {
  const line = COMPARE_LINES[Math.min(index, COMPARE_LINES.length - 1)];
  return { colour: colours[line.colour], dashed: line.dashed, width: line.width };
}

/** Returns from a common start, one line per company, dates as the reader writes them. */
export function compareReturnsOption(colours: ChartColours, tickers: string[], dates: string[],
  returns: Array<Array<number | null>>, locale: Locale): EChartsOption {
  return {
    legend: { top: 0, data: tickers, textStyle: { color: colours.text } },
    grid: { top: 50, left: 65, right: 20, bottom: 45 },
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { hideOverlap: true, formatter: (value: string) => formatCalendarDate(value, locale) },
    },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => minus(percent(value)) } },
    series: tickers.map((symbol, index) => {
      const stroke = compareStroke(colours, index);
      return {
        name: symbol,
        type: "line" as const,
        showSymbol: false,
        connectNulls: false,
        color: stroke.colour,
        itemStyle: { color: stroke.colour },
        lineStyle: { width: stroke.width, color: stroke.colour, type: stroke.dashed ? [6, 4] : "solid" as const },
        data: returns[index],
      };
    }),
  };
}

/** One date's returns: the researched company leads, the others follow by return, and two lines add their gap. */
export function compareReading(tickers: string[], dates: string[], returns: Array<Array<number | null>>,
  colours: ChartColours, index: number, locale: Locale): Reading | null {
  if (!dates[index]) return null;
  const key = (line: number): ReadingKey => {
    const stroke = compareStroke(colours, line);
    return { colour: stroke.colour, dashed: stroke.dashed || undefined };
  };
  const value = (line: number) => returns[line]?.[index] ?? null;
  const shown = (figure: number | null) => minus(percent(figure, true, 2));
  const others = tickers.slice(1).map((ticker, offset) => ({ ticker, line: offset + 1, figure: value(offset + 1) }))
    .sort((a, b) => (b.figure ?? -Infinity) - (a.figure ?? -Infinity));
  const groups: ReadingItem[][] = [others.map(({ ticker, line, figure }) => ({ label: ticker, value: shown(figure), key: key(line) }))];
  const lead = value(0);
  if (tickers.length === 2 && lead != null && others[0]?.figure != null) {
    const gap = (lead - others[0].figure) * 100;
    groups.push([{ label: locale === "zh" ? "相差" : "Difference", value: minus((gap > 0 ? "+" : "") + gap.toFixed(2)) + " pp", tone: readingTone(gap) }]);
  }
  return {
    time: formatCalendarDate(dates[index], locale),
    primary: { label: tickers[0], key: key(0), value: shown(lead), tone: readingTone(lead) },
    groups,
  };
}

export function ResearchComparison({
  ticker,
  instruments,
}: {
  ticker: string;
  instruments: { ticker: string; name: string; lastRunId?: string | null; isFund?: boolean | null }[];
}) {
  const { locale } = useLocale();
  const colours = useChartColours();
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const opened = params.get("compare") === "on",
    kind = params.get("comparePeriod") ?? "ttm",
    range = params.get("compareRange") ?? "1Y",
    multiple = params.get("compareMultiple") === "ps" ? "ps" : "pe";
  const tickers = [
    ...new Set([ticker, ...(params.get("peers") ?? "").split(",")]),
  ]
    .filter((s) => instruments.some((i) => i.ticker === s))
    .slice(0, 4);
  const requests = useQueries({
    queries: (opened ? tickers : []).map((symbol) => ({
      ...researchLensQuery(symbol, "fundamentals", instruments.find((i) => i.ticker === symbol)?.lastRunId, "summary"),
      enabled: opened,
      staleTime: 300000,
      retry: false,
    })),
  });
  const prices = useQueries({
    queries: (opened ? tickers : []).map((symbol) => ({
      ...researchPriceQuery(symbol, instruments.find((i) => i.ticker === symbol)?.lastRunId),
      enabled: opened,
      staleTime: 300000,
      retry: false,
    })),
  });
  const years = [
    ...new Set(
      requests.flatMap(
        (q) =>
          q.data?.financialFacts?.periods
            ?.filter((p) => p.kind === "annual")
            .map((p) => String(p.fiscalYear)) ?? [],
      ),
    ),
  ]
    .sort()
    .reverse();
  const cols = requests.map((q, i) => {
    const f = q.data?.financialFacts;
    const p = f?.periods?.find((p) =>
      kind === "ttm"
        ? p.id === f.latestTtm
        : p.kind === "annual" && String(p.fiscalYear) === kind,
    );
    return {
      symbol: tickers[i],
      data: q.data,
      period: p,
      get: f ? factIndex(f) : () => undefined,
      error: q.isError,
    };
  });
  const common =
    prices.every(
      (q) => q.data?.currency && q.data.currency === prices[0]?.data?.currency,
    ) && prices.length > 1;
  const maps = prices.map(
    (q) => new Map(q.data?.points.map((p) => [p.date, p.close])),
  );
  let dates =
    prices[0]?.data?.points
      .map((p) => p.date)
      .filter((d) => maps.every((m) => m.has(d))) ?? [];
  const end = dates.at(-1);
  if (end) {
    const from = new Date(end);
    from.setUTCFullYear(
      from.getUTCFullYear() - (range === "5Y" ? 5 : range === "3Y" ? 3 : 1),
    );
    dates = dates.filter((d) => d >= from.toISOString().slice(0, 10));
  }
  const returnSeries = maps.map((map) => dates.map((date) => {
    const start = map.get(dates[0]), close = map.get(date);
    return start != null && close != null && start !== 0 ? close / start - 1 : null;
  }));
  const returnsReadout = bridgeReadout({
    positions: dates.map((_, index) => index),
    read: (position) => compareReading(tickers, dates, returnSeries, colours, position, locale),
    latest: minus(percent(returnSeries[0]?.at(-1), true, 2)),
    marks: (position) => tickers.flatMap((_, line) => {
      const value = returnSeries[line]?.[position];
      return value == null ? [] : [{ value, colour: compareStroke(colours, line).colour }];
    }),
  });
  const metrics = [
    "revenueGrowth",
    "netMargin",
    "operatingMargin",
    "fcfMargin",
    "roe",
    "debtEquity",
    "pe",
    "ps",
    "fcfYield",
  ];
  const extra: Record<string, [string, string]> = {
    debtEquity: ["债务 / 权益", "Debt / equity"],
    pe: ["现价 / 盈利", "Price / earnings"],
    ps: ["现价 / 销售额", "Price / sales"],
    fcfYield: ["现金流收益率", "FCF yield"],
  };
  const readValue = (col: (typeof cols)[number], key: string) => {
    if (!col.period) return null;
    const v = (k: string) => col.get(col.period!.id, k)?.value;
    const info = object(object(col.data?.fundamentals).metrics),
      spot = col.data?.context?.quote.price,
      shares = numeric(info.sharesOutstanding),
      cap = spot && shares ? spot * shares : null;
    const sameCurrency =
      col.data?.context?.quote.currency === col.data?.financialFacts?.currency;
    let n: number | null | undefined;
    if (key === "pe") {
      const income = v("netIncome");
      if (income != null && income <= 0) return "N/M";
      n = cap && sameCurrency && income ? cap / income : null;
    } else if (key === "ps") {
      const sales = v("revenue");
      n = cap && sameCurrency && sales && sales > 0 ? cap / sales : null;
    } else if (key === "fcfYield") {
      const fcf = v("freeCashflow");
      n = cap && sameCurrency && fcf != null ? fcf / cap : null;
    } else if (key === "debtEquity") {
      const debt = v("debt"),
        equity = v("equity");
      n = debt != null && equity && equity > 0 ? debt / equity : null;
    } else n = v(key);
    return n ?? null;
  };
  const read = (col: (typeof cols)[number], key: string) => {
    const n = readValue(col, key);
    if (n === "N/M") return n;
    return ["pe", "ps", "debtEquity"].includes(key)
      ? n == null
        ? "—"
        : number(n, 2) + "×"
      : percent(n, key.includes("Growth"), 2);
  };
  return (
    <>
      <Button
        variant="default"
        size="sm"
        onClick={() => update({ compare: "on" })}
      >
        {t("比较", "Compare")}
      </Button>
      <Modal
        opened={opened}
        onClose={() => update({ compare: null })}
        title={t("公司对比", "Compare companies")}
        size="min(1200px, 96vw)"
      >
        <div className="mx-toolbar">
          <MultiSelect
            renderPill={({ option, onRemove }) => (
              <Pill
                withRemoveButton={option.value !== ticker}
                onRemove={onRemove}
                removeButtonProps={{
                  "aria-label": t("移除 ", "Remove ") + option.label,
                }}
              >
                {option.label}
              </Pill>
            )}
            label={t("最多 4 家公司", "Up to 4 companies")}
            searchable
            data={instruments.filter((i) => !i.isFund).map((i) => ({
              value: i.ticker,
              label: `${i.ticker} · ${i.name}`,
            }))}
            value={tickers}
            onChange={(v) =>
              update({
                peers: v
                  .filter((x) => x !== ticker)
                  .slice(0, 3)
                  .join(","),
              })
            }
            maxValues={4}
            w={600}
            maw="100%"
          />
          <Select
            label={t("财务期间", "Financial period")}
            value={kind}
            onChange={(v) => update({ comparePeriod: v })}
            data={[
              { value: "ttm", label: "TTM" },
              ...years.map((y) => ({ value: y, label: "FY" + y })),
            ]}
          />
        </div>
        {requests.some((q) => q.isPending) ? (
          <Pending />
        ) : (
          <div
            className="mx-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("财务指标比较", "Financial comparison")}
          >
            <table className="mx-financial-table">
              <thead>
                <tr>
                  <th>{t("指标", "Metric")}</th>
                  {cols.map((col) => (
                    <th key={col.symbol}>
                      {col.symbol}
                      <small>
                        {col.error
                          ? t("载入失败", "Load failed")
                          : (col.period?.label ??
                            t("无匹配财报", "No matching financials"))}
                      </small>
                      <small>
                        {col.period ? formatCalendarDate(col.period.actualEnd ?? col.period.providerEnd, locale) : ""}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((key) => (
                  <tr key={key}>
                    <th>{t(...(metricNames[key] ?? extra[key]))}</th>
                    {cols.map((col) => (
                      <td key={col.symbol}>{read(col, key)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cols.length > 1 &&
          cols.some((col) => typeof readValue(col, multiple) === "number") && (
            <Panel
              title={t("估值倍数", "Valuation multiples")}
              action={
                <Segments
                  label={t("比较倍数", "Valuation multiple")}
                  value={multiple}
                  onChange={(v) => update({ compareMultiple: v })}
                  options={[
                    { value: "pe", label: "P/E" },
                    { value: "ps", label: "P/S" },
                  ]}
                />
              }
            >
              <Plot
                research
                height={220}
                label={t(
                  "现价相对所选财期的估值倍数",
                  "Current-price multiples for the selected financial period",
                )}
                option={(c) => ({
                  grid: { top: 30, left: 56, right: 24, bottom: 36 },
                  xAxis: {
                    type: "category",
                    data: cols.map((col) => col.symbol),
                  },
                  yAxis: {
                    type: "value",
                    name: "×",
                    axisLabel: { formatter: (v: number) => number(v, 1) + "×" },
                  },
                  // Each point already carries its multiple as a label.
                  tooltip: { show: false },
                  series: [
                    {
                      type: "scatter",
                      name: multiple.toUpperCase().replace("P", "P/"),
                      symbolSize: 12,
                      data: cols.map((col) => {
                        const value = readValue(col, multiple);
                        return typeof value === "number" ? value : null;
                      }),
                      itemStyle: { color: c.brand },
                      label: {
                        show: true,
                        position: "top",
                        color: c.text,
                        formatter: (p) => read(cols[p.dataIndex], multiple),
                      },
                    },
                  ],
                })}
              />
            </Panel>
          )}
        <Panel
          title={t("含分红复权回报", "Dividend-adjusted returns")}
          action={
            <Segments
              label={t("比较区间", "Comparison range")}
              value={range}
              onChange={(v) => update({ compareRange: v })}
              options={["1Y", "3Y", "5Y"].map((value) => ({
                value,
                label: value,
              }))}
            />
          }
        >
          {prices.some((q) => q.isPending) ? (
            <Pending />
          ) : !common || dates.length < 2 ? (
            <Empty
              title={t(
                "所选公司没有同币种的共同历史",
                "No shared history in one currency",
              )}
            />
          ) : (
            <>
              <Plot
                research
                label={t("共同起点回报", "Returns from a common start")}
                readout={returnsReadout}
                option={(c) => compareReturnsOption(c, tickers, dates, returnSeries, locale)}
              />
              <div className="mx-chart-footer">
                <span>{formatDateSpan(dates[0], dates.at(-1), locale)}</span>
                <span>{prices[0].data?.currency}</span>
              </div>
              <FactsEnd
                tickers={tickers}
                values={maps.map(
                  (m) => m.get(dates.at(-1)!)! / m.get(dates[0])! - 1,
                )}
              />
            </>
          )}
        </Panel>
        <details>
          <summary>{t("比较口径", "Comparison basis")}</summary>
          <p>
            {t(
              "TTM 各取最新完整四季，截止日列在表头；年度按财年标签匹配。现价倍数使用所选期间的财务数据，不是历史时点倍数。跨币种金额不直接相除；未匹配数据不排名。",
              "TTM uses each company's latest complete four quarters, with endpoints shown above. Annual periods match fiscal-year labels. Current-price multiples use the selected financial period; they are not historical multiples. Unmatched currencies and missing data are not ranked.",
            )}
          </p>
        </details>
      </Modal>
    </>
  );
}
function FactsEnd({
  tickers,
  values,
}: {
  tickers: string[];
  values: number[];
}) {
  return (
    <div className="mx-metric-grid">
      {tickers.map((ticker, i) => (
        <div key={ticker}>
          <strong>{ticker}</strong>
          <p>{percent(values[i], true, 2)}</p>
        </div>
      ))}
    </div>
  );
}
