"use client";

import { WorkspaceSheet } from "./overlay";
import { FormField } from "@/components/ui/form-field";
import { NumericInput } from "@/components/ui/numeric-input";
import type { ResearchLensSnapshot } from "@/lib/types";
import {
  CheckIcon,
  Combobox,
  MultiSelect,
  Pill,
  Select,
} from "@mantine/core";
import { Checkbox } from "@/components/ui/checkbox";
import { useLocalStorage } from "@/lib/hooks";
import type { BarSeriesOption, EChartsOption, LineSeriesOption } from "echarts";
import { useState } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { useChartColours, type ChartColours } from "@/ui/charts/palette";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { Plot } from "./charts";
import type { ChartReadout, Reading, ReadingItem, ReadingMark } from "./chart-readout";
import { compact, compactTick, number, object, percent, str } from "@/workspace/data";
import { EvidenceTable } from "./evidence-table";
import { quoteUnit, quoteValue } from "./financial-values";
import {
  Empty,
  Facts,
  Metric,
  Panel,
  Segments,
  Tag,
  useCopy,
} from "./foundation";
import { nearMoneyStrikes } from "./research-math";
import { minus } from "./reading-figures";
import { readingTone, signedNumber, signedPounds } from "./reading-format";
import { usFundRelation } from "./research-fund-reference";
import { useRouteState } from "./route-state";

type Chain = NonNullable<ResearchLensSnapshot["options"]>;
type Contract = Chain["contracts"][number];
const baseColumns = ["bid", "ask", "iv", "oi", "volume"];
/** Column names read in the reader's language; the table keeps its classic layout. */
function chainColumns(t: (zh: string, en: string) => string): Record<string, string> {
  return {
    bid: t("买价", "Bid"),
    ask: t("卖价", "Ask"),
    iv: t("隐含波动率", "IV"),
    oi: t("未平仓", "OI"),
    volume: t("成交量", "Volume"),
    last: t("最新价", "Last"),
    spread: t("价差", "Spread"),
    delta: "Delta",
    gamma: "Gamma",
  };
}
function validQuote(c: Contract) {
  return (
    c.bid != null && c.ask != null && c.bid >= 0 && c.ask > 0 && c.ask >= c.bid
  );
}
function sum(values: (number | null | undefined)[]) {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  return valid.length ? valid.reduce((n, v) => n + v, 0) : null;
}

/** Calls and puts keep one colour each on bars, lines, legends and reading keys. */
const SIDES = ["call", "put"] as const;
type Side = (typeof SIDES)[number];
export function sideStroke(side: Side, colours: ChartColours) {
  return side === "call" ? colours.comparison : colours.accent;
}

/**
 * Expirations on one chart: the first selected leads in cobalt and solid, the others in ink and
 * grey, dashed or dotted, as comparison lines are elsewhere. Line, legend, dot and key share it.
 */
const EXPIRY_LINES = [
  { colour: "brand", dash: "solid", width: 2 },
  { colour: "text", dash: "dashed", width: 1.6 },
  { colour: "axis", dash: "dotted", width: 1.6 },
  { colour: "axis", dash: "dashed", width: 1.6 },
  { colour: "text", dash: "dotted", width: 1.6 },
] as const satisfies ReadonlyArray<{ colour: keyof ChartColours; dash: "solid" | "dashed" | "dotted"; width: number }>;
export function expiryStroke(colours: ChartColours, index: number) {
  const line = EXPIRY_LINES[Math.min(index, EXPIRY_LINES.length - 1)];
  return { colour: colours[line.colour], dashed: line.dash === "dashed", dotted: line.dash === "dotted", width: line.width };
}
/** One stroke per selected expiration, so no two lines on a chart share one. */
export const MAX_EXPIRIES = EXPIRY_LINES.length;

/** Open interest summed by strike, calls then puts. */
export function interestByStrike(contracts: ReadonlyArray<Pick<Contract, "strike" | "side" | "openInterest">>) {
  const strikes = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
  const counts = SIDES.map((side) => strikes.map((strike) =>
    sum(contracts.filter((c) => c.strike === strike && c.side === side).map((c) => c.openInterest))));
  return { strikes, counts };
}

/** Each side's bars take its colour, so the legend swatch and the reading's key match them. */
export function interestSeries(colours: ChartColours, names: Record<Side, string>,
  counts: ReadonlyArray<ReadonlyArray<number | null>>): BarSeriesOption[] {
  return SIDES.map((side, s) => ({
    name: names[side],
    type: "bar",
    color: sideStroke(side, colours),
    itemStyle: { color: sideStroke(side, colours) },
    data: [...counts[s]],
  }));
}

/** One strike's open interest: a whole-contract count per side, keyed to its bars. */
export function interestRows(colours: ChartColours, names: Record<Side, string>,
  counts: ReadonlyArray<ReadonlyArray<number | null>>, index: number): ReadingItem[] {
  return SIDES.flatMap((side, s) => counts[s][index] == null ? [] : [{
    label: names[side], value: number(counts[s][index], 0), key: { colour: sideStroke(side, colours), kind: "bar" as const },
  }]);
}

/** One expiration's net gamma per 1% move across spot scenarios, named as its legend entry. */
export type GammaLine = { name: string; profile: ReadonlyArray<{ spot: number; netGex: number }> };

/** One line per expiration in its own stroke; the first also draws the chart's single zero line. */
export function gammaSeries(colours: ChartColours, lines: readonly GammaLine[]): LineSeriesOption[] {
  return lines.map((line, index) => {
    const stroke = expiryStroke(colours, index);
    return {
      name: line.name,
      type: "line",
      showSymbol: false,
      connectNulls: false,
      color: stroke.colour,
      itemStyle: { color: stroke.colour },
      lineStyle: { color: stroke.colour, width: stroke.width, type: stroke.dashed ? [6, 4] : stroke.dotted ? "dotted" : "solid" },
      data: line.profile.map((p) => [p.spot, p.netGex]),
      ...(index ? {} : {
        markLine: {
          symbol: "none",
          silent: true,
          label: { show: false },
          lineStyle: { color: colours.axis, type: "solid", width: 1 },
          data: [{ yAxis: 0 }],
        },
      }),
    };
  });
}

const gexFormats = new Map<Locale, Intl.NumberFormat>();
/** Net gamma in the axis's compact units to four significant digits, finer than its round ticks. */
export function gexFigure(value: number, locale: Locale) {
  let format = gexFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-GB", { notation: "compact", maximumSignificantDigits: 4 });
    gexFormats.set(locale, format);
  }
  return minus(format.format(value));
}

function gammaAt(line: GammaLine, spot: number) {
  return line.profile.find((p) => p.spot === spot)?.netGex ?? null;
}

/**
 * One spot scenario. A single expiration needs no label; several lead with the first and key
 * every row to its line. Net gamma is not a gain or loss, so it stays in ink.
 */
export function gammaReading(colours: ChartColours, lines: readonly GammaLine[], spot: number, locale: Locale, unit: string): Reading | null {
  const rows = lines.flatMap((line, index): ReadingItem[] => {
    const net = gammaAt(line, spot);
    if (net == null) return [];
    const stroke = expiryStroke(colours, index);
    return [{
      label: line.name,
      value: gexFigure(net, locale),
      key: { colour: stroke.colour, ...(stroke.dashed ? { dashed: true } : {}), ...(stroke.dotted ? { dotted: true } : {}) },
    }];
  });
  const [lead, ...rest] = rows;
  if (!lead) return null;
  return { time: quoteValue(spot, unit, { style: "figure" }), primary: lines.length > 1 ? lead : { value: lead.value }, ...(rest.length ? { groups: [rest] } : {}) };
}

export function gammaMarks(colours: ChartColours, lines: readonly GammaLine[], spot: number): ReadingMark[] {
  return lines.flatMap((line, index) => {
    const net = gammaAt(line, spot);
    return net == null ? [] : [{ value: net, colour: expiryStroke(colours, index).colour }];
  });
}

/** The cobalt payoff line, with a quiet zero line: the chart's one series. */
export function payoffSeries(colours: ChartColours, name: string, points: ReadonlyArray<readonly [number, number]>): LineSeriesOption[] {
  return [{
    name,
    type: "line",
    showSymbol: false,
    color: colours.brand,
    itemStyle: { color: colours.brand },
    lineStyle: { color: colours.brand, width: 2 },
    data: points.map(([price, result]) => [price, result]),
    markLine: {
      symbol: "none",
      silent: true,
      label: { show: false },
      lineStyle: { color: colours.axis, type: "solid", width: 1 },
      data: [{ yAxis: 0 }],
    },
  }];
}

/** A hypothetical result at one underlying price: signed and toned, pounds as £, other currencies as the axis names them. */
export function payoffReading(atExpiry: string, price: number, result: number, currencyCode: string): Reading {
  return {
    time: atExpiry + " " + quoteValue(price, currencyCode, { style: "figure" }),
    primary: { value: currencyCode === "GBP" ? signedPounds(result) : signedNumber(result, 2), tone: readingTone(result, 2) },
  };
}
/**
 * Before the market opens a contract can have neither bid nor ask. Its implied
 * volatility and greeks are then provider placeholders, so the chain shows "—".
 */
function quoted(c: Contract) {
  return (c.bid ?? 0) > 0 || (c.ask ?? 0) > 0;
}
/** One rule for the table and the volatility charts: a quoted contract with a real IV. */
function usableIv(c: Contract) {
  return quoted(c) && c.impliedVolatility != null && c.impliedVolatility > 0.0001;
}
function cell(c: Contract | undefined, key: string, unit: string, style: "figure" | "money" = "figure") {
  if (!c) return "—";
  if (!quoted(c) && ["bid", "ask", "iv", "delta", "gamma"].includes(key)) return "—";
  if (key === "ask" && !(c.ask! > 0)) return "—";
  if (key === "iv") return usableIv(c) ? percent(c.impliedVolatility) : "—";
  if (key === "spread") return validQuote(c) ? quoteValue(c.ask! - c.bid!, unit, { style }) : "—";
  const value = {
    bid: c.bid,
    ask: c.ask,
    oi: c.openInterest,
    volume: c.volume,
    last: c.lastPrice,
    delta: c.delta,
    gamma: c.gamma,
  }[key as "bid"];
  if (["bid", "ask", "last"].includes(key)) return quoteValue(value, unit, { style });
  return number(
    value,
    key === "oi" || key === "volume" ? 0 : key === "gamma" ? 5 : 2,
  );
}

/**
 * Opens the chain at the money: when the table is wider or taller than its region,
 * the strike column is centred between calls and puts and the row nearest spot is
 * centred vertically. It runs once per mount; the region is keyed by expiry and columns.
 */
function centreChain(region: HTMLDivElement | null) {
  if (!region) return;
  const calls = region.querySelector<HTMLTableCellElement>("thead tr:first-child th");
  const headings = [...region.querySelectorAll<HTMLElement>("thead tr:nth-child(2) th")];
  const strike = calls ? headings[calls.colSpan] : undefined;
  if (calls && strike && region.scrollWidth > region.clientWidth) {
    const before = headings
      .slice(0, calls.colSpan)
      .reduce((width, cell) => width + cell.getBoundingClientRect().width, 0);
    region.scrollLeft = before + strike.getBoundingClientRect().width / 2 - region.clientWidth / 2;
  }
  const row = region.querySelector<HTMLElement>("tbody .mx-near-spot");
  if (row && region.scrollHeight > region.clientHeight) {
    const top = row.getBoundingClientRect().top - region.getBoundingClientRect().top + region.scrollTop;
    region.scrollTop = top - (region.clientHeight - row.offsetHeight) / 2;
  }
}

export function OptionsView({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy(),
    { params, update } = useRouteState();
  const columnNames = chainColumns(t);
  const { locale, timeZone } = useLocale();
  const colours = useChartColours();
  const [columns, setColumns] = useLocalStorage<string[]>({
    key: "mx-option-columns-v2",
    defaultValue: baseColumns,
  });
  const [liquid, setLiquid] = useState(false),
    [allStrikes, setAllStrikes] = useState(false),
    [detail, setDetail] = useState<Contract | null>(null);
  const options = data.options;
  const peer = data.optionsPeer;
  const title = peer
    ? t("{ticker} 期权链", "{ticker} option chain").replace("{ticker}", peer.fund.ticker)
    : t("期权链", "Option chain");
  const relationship = peer
    ? <p className="mx-muted">{usFundRelation(peer, t)} · {t(
      "标的价格和行权价均为 {ticker} 的 USD 报价。",
      "Underlying prices and strikes are for {ticker}, in USD.",
    ).replace("{ticker}", peer.fund.ticker)}</p>
    : null;
  const notApplicable = data.context?.capabilities?.some((capability) =>
    capability.task === "options" && capability.state === "notApplicable",
  );
  if (!options)
    return (
      <Panel title={peer ? title : undefined}>
        {relationship}
        <Empty title={notApplicable
          ? t("此基金暂无适用的期权标的", "No applicable options underlying")
          : t("当前期权数据不可用", "Current chain unavailable")}
          description={notApplicable
            ? t("此份额没有可用的期权标的。可返回基金概览查看现有资料。", "There’s no options underlying for this listing. Return to the fund overview for available research.")
            : t("行情源没有可用的期权链，也没有保存的合约。可更新研究后重试。", "The quote source returned no chain and there are no saved contracts. Refresh research and try again.")} />
      </Panel>
    );
  const historical = params.get("chainMode") === "history";
  const current = options.availability?.currentExpiries ?? [];
  const available = options.expiries.map((e) => e.expiry).sort();
  const dates = historical ? available : current;
  const requested = (params.get("expiries") ?? "")
    .split(",")
    .filter((v) => dates.includes(v))
    .slice(0, MAX_EXPIRIES);
  const selected = requested.length ? requested : dates.slice(0, 1);
  const mode = params.get("optionView") ?? "chain";
  const scoped = options.contracts.filter((c) => selected.includes(c.expiry));
  const filtered = liquid ? scoped.filter(validQuote) : scoped;
  const cc = options.currency || "";
  const displayCurrency = quoteUnit(cc).currency;
  const value = (v: unknown) =>
    quoteValue(v, cc, { unknownLabel: t("币种未提供", "Currency unavailable") });
  const calls = scoped.filter((c) => c.side === "call"),
    puts = scoped.filter((c) => c.side === "put");
  const coi = sum(calls.map((c) => c.openInterest)),
    poi = sum(puts.map((c) => c.openInterest));
  const gexContracts = scoped.filter((c) => c.gex1pct != null);
  const gex = sum(gexContracts.map((c) => c.gex1pct));
  const active = selected[0] ?? "";
  const oneExpiry = filtered.filter((c) => c.expiry === active);
  const all = [...new Set(oneExpiry.map((c) => c.strike))].sort(
    (a, b) => a - b,
  );
  const strikes = allStrikes ? all : nearMoneyStrikes(all, options.spot, 19);
  const nearest = nearMoneyStrikes(all, options.spot, 1)[0];
  const activeSummary = options.expiries.find((e) => e.expiry === active);
  const activeCols = columns.length ? columns : baseColumns;
  const sideNames: Record<Side, string> = { call: t("看涨", "Calls"), put: t("看跌", "Puts") };
  // Open interest by strike across the selected expirations; a reading names the strike as the axis does.
  const interest = interestByStrike(filtered);
  const interestAt = (i: number) => interestRows(colours, sideNames, interest.counts, i);
  const interestNearest = interest.strikes.indexOf(nearMoneyStrikes(interest.strikes, options.spot, 1)[0]);
  const interestReadout: ChartReadout = {
    positions: interest.strikes.map((_, i) => i),
    read: (i) => interest.strikes[i] == null ? null
      : { time: t("行权价", "Strike") + " " + quoteValue(interest.strikes[i], cc, { style: "code", digits: 8 }), groups: [interestAt(i)] },
    latest: interestNearest >= 0 ? interestAt(interestNearest).map((row) => row.label + " " + row.value).join(" · ") : "—",
  };
  // Net gamma per 1% move across spot scenarios, one line per selected expiration.
  const gammaLines: GammaLine[] = options.expiries
    .filter((e) => selected.includes(e.expiry))
    .map((e) => ({ name: formatCalendarDate(e.expiry, locale), profile: e.gammaProfile }));
  const gammaSpots = [...new Set(gammaLines.flatMap((line) => line.profile.map((p) => p.spot)))].sort((a, b) => a - b);
  const gammaNearest = gammaSpots.reduce<number | null>((best, spot) =>
    best == null || Math.abs(spot - options.spot) < Math.abs(best - options.spot) ? spot : best, null);
  const gammaLatest = gammaNearest == null ? null : gammaReading(colours, gammaLines, gammaNearest, locale, cc);
  const gammaReadout: ChartReadout = {
    positions: gammaSpots,
    read: (spot) => gammaReading(colours, gammaLines, spot, locale, cc),
    marks: (spot) => gammaMarks(colours, gammaLines, spot),
    latest: gammaLatest
      ? [gammaLatest.primary!, ...(gammaLatest.groups?.[0] ?? [])].map((row) => [row.label, row.value].filter(Boolean).join(" ")).join(" · ")
      : "—",
  };
  const when = (v?: string | null) => (v ? formatDateTime(v, locale, timeZone) : "—");
  const full = selected.length >= MAX_EXPIRIES;
  const fullReason = locale === "zh" ? `已选满 ${MAX_EXPIRIES} 个到期日` : `limit of ${MAX_EXPIRIES} expirations reached`;
  const listedExpiries = options.availableExpiries?.length ?? 0;
  const partialExpiries = listedExpiries > 0 && available.length < listedExpiries;
  const models = object(options.modelInputs),
    rate = object(models.rate);
  return (
    <>
      <Panel
        title={title}
        action={
          <div className="flex flex-wrap items-center gap-mx-sm">
            {(historical || !current.length) && (
              <Tag tone="warn">{options.capturedAt
                ? <>{t("存档期权链", "Archived chain")} · <time dateTime={options.capturedAt}>{when(options.capturedAt)}</time></>
                : t("存档期权链 · 日期未提供", "Archived chain · date unavailable")}</Tag>
            )}
            {!historical && current.length > 0 && <span className="mx-muted">{when(options.capturedAt)}</span>}
          </div>
        }
      >
        {relationship}
        <div className="mx-toolbar">
          <Segments
            label={t("期权快照", "Chain snapshot")}
            value={historical ? "history" : "current"}
            onChange={(v) => update({ chainMode: v, expiries: null })}
            options={[
              { value: "current", label: t("当前", "Current") },
              { value: "history", label: t("历史", "Historical") },
            ]}
          />
          {dates.length > 0 && (
            <MultiSelect
              renderPill={({ option, onRemove }) => (
                <Pill
                  withRemoveButton
                  onRemove={onRemove}
                  removeButtonProps={{
                    "aria-label":
                      t("移除到期日 ", "Remove expiration ") + option.label,
                  }}
                >
                  {option.label}
                </Pill>
              )}
              // Once five are chosen the rest are disabled, and their names say why. Chosen ones keep the check.
              renderOption={({ option, checked }) => (
                <>
                  {checked && <CheckIcon className={Combobox.classes.optionsDropdownCheckIcon} />}
                  {option.disabled ? <>
                    <span aria-hidden="true">{option.label}</span>
                    <span className="sr-only">{option.label + t("，", ", ") + fullReason}</span>
                  </> : <span>{option.label}</span>}
                </>
              )}
              aria-label={t("选择已采集到期日", "Select captured expirations")}
              data={dates.map((date) => ({
                value: date,
                label: formatCalendarDate(date, locale),
                disabled: full && !selected.includes(date),
              }))}
              maxValues={MAX_EXPIRIES}
              value={selected}
              onChange={(v) => {
                if (v.length) update({ expiries: v.join(",") });
              }}
              w={320}
            />
          )}
          <span className={partialExpiries ? "mx-warning-text" : "mx-muted"}>
            {t("已采集", "Captured")} {available.length}
            {listedExpiries ? ` / ${listedExpiries}` : ""}{" "}
            {(listedExpiries || available.length) === 1 ? t("个到期日", "expiration") : t("个到期日", "expirations")}
          </span>
        </div>
        {!dates.length ? (
          <Empty
            title={t("当前期权数据不可用", "Current chain unavailable")}
            description={t(
              "最后成功快照已过时。可以更新研究或查看历史合约。",
              "The last successful snapshot is historical. Refresh research or inspect the captured contracts.",
            )}
            action={available.length > 0 && !historical &&
              <Button
                variant="secondary"
                onClick={() => update({ chainMode: "history", expiries: null })}
              >
                {t("查看历史快照", "View historical snapshot")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="mx-metric-grid" style={{ margin: "24px 0" }}>
              <Metric
                label={t("快照标的价", "Underlying at capture")}
                value={value(options.spot)}
              />
              <Metric
                label={t("Call / Put 持仓量", "Call / Put open interest")}
                value={`${compact(coi, locale)} / ${compact(poi, locale)}`}
              />
              <Metric
                label={t("Put / Call 持仓比", "Put / Call OI")}
                value={
                  coi != null && coi > 0 && poi != null
                    ? number(poi / coi, 2)
                    : "—"
                }
              />
              <Metric
                label={t("合约覆盖", "Contracts captured")}
                value={number(scoped.length, 0)}
              />
            </div>
            <Segments
              label={t("期权分析", "Options analysis")}
              value={mode}
              onChange={(v) => update({ optionView: v })}
              options={[
                { value: "chain", label: t("配对链", "Paired chain") },
                { value: "iv", label: t("隐含波动率", "Implied volatility") },
                { value: "interest", label: t("持仓分布", "Open interest") },
                { value: "gamma", label: t("Gamma 估算", "Gamma estimate") },
                { value: "payoff", label: t("到期损益试算", "Expiry payoff") },
              ]}
            />
            {(mode === "chain" || mode === "iv") && (
              <div className="mx-toolbar" style={{ marginTop: 20 }}>
                <Checkbox
                  label={t("仅有效双边报价", "Valid two-sided quotes")}
                  checked={liquid}
                  onCheckedChange={(checked) => setLiquid(checked)}
                />
                {selected.length > 1 && (
                  <Select
                    label={t("详细到期日", "Detail expiration")}
                    data={selected.map((date) => ({ value: date, label: formatCalendarDate(date, locale) }))}
                    value={active}
                    onChange={(v) => {
                      if (v)
                        update({
                          expiries: [
                            v,
                            ...selected.filter((x) => x !== v),
                          ].join(","),
                        });
                    }}
                  />
                )}
              </div>
            )}
            {mode === "chain" && (
              <>
                <div className="mx-toolbar" style={{ margin: "20px 0" }}>
                  <MultiSelect
                    renderPill={({ option, onRemove }) => (
                      <Pill
                        withRemoveButton
                        onRemove={onRemove}
                        removeButtonProps={{
                          "aria-label":
                            t("移除列 ", "Remove column ") + option.label,
                        }}
                      >
                        {option.label}
                      </Pill>
                    )}
                    aria-label={t("期权链列", "Option chain columns")}
                    data={Object.entries(columnNames).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    value={activeCols}
                    onChange={setColumns}
                    w={480}
                  />
                  <Checkbox
                    label={t("所有行权价", "All strikes")}
                    checked={allStrikes}
                    onCheckedChange={(checked) => setAllStrikes(checked)}
                  />
                  {strikes.length < all.length && (
                    <span className="mx-muted">
                      {strikes.length} / {all.length} {t("档", "strikes")}
                    </span>
                  )}
                </div>
                <div
                  key={active + "|" + activeCols.join(",") + "|" + allStrikes}
                  ref={centreChain}
                  className="mx-table-wrap mx-option-chain"
                  role="region"
                  tabIndex={0}
                  aria-label={t("看涨与看跌配对链", "Paired calls and puts")}
                >
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th colSpan={activeCols.length}>{t("看涨", "Calls")}</th>
                        <th className="mx-strike">
                          {t("行权价", "Strike")} · {displayCurrency}
                        </th>
                        <th colSpan={activeCols.length}>{t("看跌", "Puts")}</th>
                      </tr>
                      <tr>
                        {activeCols.toReversed().map((k) => (
                          <th scope="col" key={k}>
                            {columnNames[k]}
                          </th>
                        ))}
                        <th scope="col" className="mx-strike">
                          {formatCalendarDate(active, locale)}
                        </th>
                        {activeCols.map((k) => (
                          <th scope="col" key={k}>
                            {columnNames[k]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {strikes.map((strike) => {
                        const call = oneExpiry.find(
                            (c) => c.strike === strike && c.side === "call",
                          ),
                          put = oneExpiry.find(
                            (c) => c.strike === strike && c.side === "put",
                          );
                        return (
                          <tr
                            key={strike}
                            className={
                              strike === nearest ? "mx-near-spot" : undefined
                            }
                          >
                            {activeCols.toReversed().map((k) => {
                              const primary = k === activeCols[0];
                              return (
                                <td
                                  key={k}
                                  className={
                                    call?.inTheMoney ? "mx-option-itm" : undefined
                                  }
                                >
                                  {primary && call ? (
                                    <button
                                      type="button"
                                      className="mx-cell-button"
                                      onClick={() => setDetail(call)}
                                      aria-label={`${t("看涨", "Call")} ${value(strike)} ${columnNames[k]} ${cell(call, k, cc)}`}
                                    >
                                      {cell(call, k, cc)}
                                    </button>
                                  ) : (
                                    cell(call, k, cc)
                                  )}
                                </td>
                              );
                            })}
                            <th scope="row" className="mx-strike">
                              {quoteValue(strike, cc, { style: "figure" })}
                              {strike === nearest && (
                                <small>{t("近现价", "Nearest spot")}</small>
                              )}
                            </th>
                            {activeCols.map((k) => {
                              const primary = k === activeCols[0];
                              return (
                                <td
                                  key={k}
                                  className={
                                    put?.inTheMoney ? "mx-option-itm" : undefined
                                  }
                                >
                                  {primary && put ? (
                                    <button
                                      type="button"
                                      className="mx-cell-button"
                                      onClick={() => setDetail(put)}
                                      aria-label={`${t("看跌", "Put")} ${value(strike)} ${columnNames[k]} ${cell(put, k, cc)}`}
                                    >
                                      {cell(put, k, cc)}
                                    </button>
                                  ) : (
                                    cell(put, k, cc)
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {mode === "iv" && (
              <Volatility
                options={options}
                contracts={oneExpiry}
                active={active}
                dates={selected}
                liquid={liquid}
              />
            )}
            {mode === "interest" && (
              <>
                <OptionPlot
                  label={t(
                    "所选到期日未平仓合约数",
                    "Open interest for selected expirations",
                  )}
                  readout={interestReadout}
                  option={(c) => ({
                    legend: { top: 0, data: [sideNames.call, sideNames.put] },
                    grid: { left: 72, right: 24, top: 42, bottom: 54 },
                    xAxis: {
                      type: "category",
                      name: t("行权价", "Strike") + " · " + displayCurrency,
                      data: interest.strikes.map((strike) => quoteValue(strike, cc, { style: "figure" })),
                    },
                    yAxis: { type: "value", name: t("合约数", "Contracts") },
                    series: interestSeries(c, sideNames, interest.counts),
                  })}
                />
                <Readings
                  columns={[
                    t("到期日", "Expiry"),
                    "Call OI",
                    "Put OI",
                    "Put / Call",
                  ]}
                  rows={options.expiries
                    .filter((e) => selected.includes(e.expiry))
                    .map((e) => [
                      formatCalendarDate(e.expiry, locale),
                      number(e.callOpenInterest, 0),
                      number(e.putOpenInterest, 0),
                      number(e.putCallOiRatio, 2),
                    ])}
                />
              </>
            )}
            {mode === "gamma" && (
              <div style={{ marginTop: 24 }}>
                <div className="mx-metric-grid">
                  <Metric
                    label={t("Gamma 敞口估算", "Estimated gamma exposure")}
                    value={value(gex)}
                    note={`${cc} / 1% ${t("标的价格变化", "underlying move")}`}
                  />
                  <Metric
                    label={t("可建模合约", "Modelled contracts")}
                    value={`${gexContracts.length} / ${scoped.length}`}
                  />
                </div>
                {gexContracts.length ? (
                  <OptionPlot
                    label={t(
                      "所选到期日的价格情景",
                      "Spot scenarios for selected expirations",
                    )}
                    readout={gammaReadout}
                    option={(c) => ({
                      legend: { top: 0, type: "scroll", data: gammaLines.map((line) => line.name) },
                      grid: { left: 80, right: 24, top: 44, bottom: 48 },
                      xAxis: { type: "value", name: displayCurrency, scale: true, axisLabel: { formatter: (v: number) => quoteValue(v, cc, { style: "figure" }) } },
                      yAxis: {
                        type: "value",
                        name: `${cc} / 1%`,
                        axisLabel: { formatter: (v: number) => minus(compactTick(v, locale)) },
                      },
                      series: gammaSeries(c, gammaLines),
                    })}
                  />
                ) : (
                  <Empty
                    title={t(
                      "必要合约条件或利率缺失",
                      "Required contract terms or rate unavailable",
                    )}
                  />
                )}
                <details>
                  <summary>{t("估算方法与输入", "Method and inputs")}</summary>
                  <Facts
                    rows={[
                      [
                        t("公式", "Formula"),
                        "Gamma × OI × multiplier × spot² × 0.01",
                      ],
                      [
                        t("符号假设", "Sign convention"),
                        t(
                          "Call 为正、Put 为负；不代表交易商实际仓位",
                          "Calls positive, puts negative; not observed dealer inventory",
                        ),
                      ],
                      [
                        t("定价近似", "Pricing approximation"),
                        str(models.pricingModel) || "—",
                      ],
                      [
                        t("风险利率", "Risk-free proxy"),
                        `${percent(rate.value)} · ${str(rate.asOf) || "—"}`,
                      ],
                      [t("利率来源", "Rate source"), str(rate.source) || "—"],
                      [t("利率方法", "Rate method"), str(rate.method) || "—"],
                      [
                        t("股息率", "Dividend yield"),
                        `${percent(models.dividendYield)} · ${str(models.dividendYieldBasis)}`,
                      ],
                      [
                        t("波动率假设", "Volatility assumption"),
                        str(models.volatilityConvention) || "—",
                      ],
                      [
                        t("模型版本", "Model version"),
                        str(models.formulaVersion) || "—",
                      ],
                    ]}
                  />
                </details>
              </div>
            )}
            {mode === "payoff" && (
              <Payoff
                contracts={scoped.filter((c) => c.expiry === active)}
                spot={options.spot}
                currencyCode={cc}
                key={active}
              />
            )}
            {activeSummary?.expiryInstant && (
              <details style={{ marginTop: 20 }}>
                <summary>
                  {t("合约时间与覆盖", "Contract time and coverage")}
                </summary>
                <Facts
                  rows={[
                    [
                      t("到期日定价截止", "Expiry pricing cutoff"),
                      when(activeSummary.expiryInstant),
                    ],
                    [t("采集时间", "Captured at"), when(options.capturedAt)],
                    [
                      t("持仓量覆盖", "OI coverage"),
                      `${scoped.filter((c) => c.openInterest != null).length} / ${scoped.length}`,
                    ],
                  ]}
                />
              </details>
            )}
          </>
        )}
      </Panel>
      <WorkspaceSheet
        open={!!detail}
        onClose={() => setDetail(null)}
        closeLabel={t("关闭合约详情", "Close contract details")}
        title={detail?.contractSymbol || t("合约详情", "Contract details")}
        width={440}
      >
        {detail && (
          <Facts
            rows={[
              [`${columnNames.bid} / ${columnNames.ask}`, `${cell(detail, "bid", cc, "money")} / ${cell(detail, "ask", cc, "money")}`],
              [columnNames.last, value(detail.lastPrice)],
              [t("最后成交", "Last trade"), when(detail.lastTradeAt)],
              [t("报价时间", "Quote time"), when(detail.quoteAsOf)],
              [t("OI 时间", "OI timestamp"), when(detail.openInterestAsOf)],
              [t("乘数", "Multiplier"), number(detail.multiplier, 0)],
              [t("行权方式", "Exercise"), detail.exerciseStyle || "—"],
              [t("结算方式", "Settlement"), detail.settlement || "—"],
              [t("到期截止", "Expiry cutoff"), when(detail.expiryInstant)],
              [
                "Delta / Gamma",
                `${number(detail.delta, 4)} / ${number(detail.gamma, 6)}`,
              ],
              ["Gamma / 1%", value(detail.gex1pct)],
              [
                t("报价质量", "Quote quality"),
                validQuote(detail)
                  ? t("有效双边报价", "Valid two-sided quote")
                  : t("缺失或交叉报价", "Missing or crossed quote"),
              ],
            ]}
          />
        )}
      </WorkspaceSheet>
    </>
  );
}

function Volatility({
  options,
  contracts,
  active,
  dates,
  liquid,
}: {
  options: Chain;
  contracts: Contract[];
  active: string;
  dates: string[];
  liquid: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const valid = contracts.filter(usableIv);
  const term = options.expiries
    .filter((e) => dates.includes(e.expiry))
    .map((e) => {
      const cs = options.contracts.filter(
        (c) =>
          c.expiry === e.expiry &&
          usableIv(c) &&
          (!liquid || validQuote(c)),
      );
      const k = nearMoneyStrikes(
        cs.map((c) => c.strike),
        options.spot,
        1,
      )[0];
      const atm = cs.filter((c) => c.strike === k);
      return {
        expiry: e.expiry,
        strike: k,
        call: atm.find((c) => c.side === "call")?.impliedVolatility ?? null,
        put: atm.find((c) => c.side === "put")?.impliedVolatility ?? null,
      };
    });
  // Calls and puts keep one colour each across the line, its dot, the legend and the reading's key.
  const sides = SIDES;
  const sideName = (side: Side) => side === "call" ? t("看涨", "Calls") : t("看跌", "Puts");
  const sideColour = (side: Side, c: ChartColours = colours) => sideStroke(side, c);
  const sideRows = (values: Array<number | null | undefined>): ReadingItem[] => sides.flatMap((side, i) =>
    values[i] == null ? [] : [{ label: sideName(side), value: percent(values[i], false, 2), key: { colour: sideColour(side) } }]);
  const sideMarks = (values: Array<number | null | undefined>) => sides.flatMap((side, i) =>
    values[i] == null ? [] : [{ value: values[i]!, colour: sideColour(side) }]);
  const smile = sides.map((side) => new Map(valid
    .filter((c) => c.side === side)
    .sort((a, b) => a.strike - b.strike)
    .map((c) => [c.strike / options.spot, c.impliedVolatility] as const)));
  const moneyness = [...new Set(smile.flatMap((line) => [...line.keys()]))].sort((a, b) => a - b);
  const atSpot = moneyness.reduce<number | null>((best, x) => best == null || Math.abs(x - 1) < Math.abs(best - 1) ? x : best, null);
  const smileReadout: ChartReadout = {
    positions: moneyness,
    read: (x) => {
      const rows = sideRows(smile.map((line) => line.get(x)));
      return rows.length ? { time: `${t("行权价 / 现价", "Strike / spot")} ${percent(x)}`, groups: [rows] } : null;
    },
    marks: (x) => sideMarks(smile.map((line) => line.get(x))),
    latest: atSpot == null ? "—" : sideRows(smile.map((line) => line.get(atSpot))).map((row) => row.label + " " + row.value).join(" · "),
  };
  const termReadout: ChartReadout = {
    positions: term.map((_, i) => i),
    read: (i) => term[i] ? { time: formatCalendarDate(term[i].expiry, locale), groups: [sideRows([term[i].call, term[i].put])] } : null,
    marks: (i) => term[i] ? sideMarks([term[i].call, term[i].put]) : [],
    latest: term.length ? sideRows([term.at(-1)!.call, term.at(-1)!.put]).map((row) => row.label + " " + row.value).join(" · ") : "—",
  };
  return (
    <div style={{ marginTop: 24 }}>
      <OptionPlot
        label={`${formatCalendarDate(active, locale)} ${t("IV 微笑", "IV smile")}`}
        readout={smileReadout}
        option={(c) => ({
          legend: { top: 0, data: [t("看涨", "Calls"), t("看跌", "Puts")] },
          grid: { left: 64, right: 24, top: 44, bottom: 54 },
          xAxis: {
            type: "value",
            name: t("行权价 / 现价", "Strike / spot"),
            scale: true,
            axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
          },
          yAxis: {
            type: "value",
            name: "IV",
            axisLabel: { formatter: (v: number) => percent(v) },
          },
          series: sides.map((side, i) => ({
            name: sideName(side),
            type: "line",
            smooth: false,
            connectNulls: false,
            symbolSize: 6,
            itemStyle: { color: sideColour(side, c) },
            lineStyle: { color: sideColour(side, c) },
            data: [...smile[i]].map(([x, iv]) => [x, iv]),
          })),
        })}
      />
      <h3>{t("近价 IV 期限结构", "ATM IV term structure")}</h3>
      {term.length > 1 && (
        <OptionPlot
          height={250}
          label={t(
            "已选到期日近价波动率",
            "ATM volatility at selected expirations",
          )}
          readout={termReadout}
          option={(c) => ({
            legend: { top: 0, data: [t("看涨", "Calls"), t("看跌", "Puts")] },
            grid: { left: 60, right: 20, top: 44, bottom: 44 },
            xAxis: { type: "category", data: term.map((r) => formatCalendarDate(r.expiry, locale)) },
            yAxis: {
              type: "value",
              name: "IV",
              axisLabel: { formatter: (v: number) => percent(v) },
            },
            series: sides.map((side) => ({
              name: sideName(side),
              type: "line",
              smooth: false,
              connectNulls: false,
              itemStyle: { color: sideColour(side, c) },
              lineStyle: { color: sideColour(side, c) },
              data: term.map((r) => (side === "call" ? r.call : r.put)),
            })),
          })}
        />
      )}
      <Readings
        columns={[
          t("到期日", "Expiry"),
          t("最近行权价", "Nearest strike"),
          "Call IV",
          "Put IV",
        ]}
        rows={term.map((r) => [
          formatCalendarDate(r.expiry, locale),
          quoteValue(r.strike, options.currency),
          percent(r.call),
          percent(r.put),
        ])}
      />
    </div>
  );
}

type Leg = {
  symbol: string;
  quantity: number;
  premium: number | null;
  fee: number;
};
function Payoff({
  contracts,
  spot,
  currencyCode,
}: {
  contracts: Contract[];
  spot: number;
  currencyCode: string;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const colours = useChartColours();
  const [legs, setLegs] = useState<Leg[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const eligible = contracts.filter(
    (c) => c.multiplier != null && c.multiplier > 0 && c.contractSymbol,
  );
  const add = () => {
    const c = eligible.find((c) => c.contractSymbol === selected);
    if (c && legs.length < 4)
      setLegs([
        ...legs,
        {
          symbol: c.contractSymbol!,
          quantity: 1,
          premium: validQuote(c) ? (c.bid! + c.ask!) / 2 : null,
          fee: 0,
        },
      ]);
  };
  const pnl = (price: number) =>
    legs.reduce((total, l) => {
      const c = eligible.find((c) => c.contractSymbol === l.symbol)!;
      return (
        total +
        ((c.side === "call"
          ? Math.max(price - c.strike, 0)
          : Math.max(c.strike - price, 0)) -
          l.premium!) *
          l.quantity *
          c.multiplier! -
        Math.abs(l.quantity) * l.fee
      );
    }, 0);
  const max = Math.max(
    spot * 1.5,
    ...legs.map(
      (l) =>
        (eligible.find((c) => c.contractSymbol === l.symbol)?.strike ?? 0) *
        1.3,
    ),
  );
  const points = [
    ...new Set([
      0,
      spot,
      ...Array.from({ length: 61 }, (_, i) => (max * i) / 60),
      ...legs.flatMap((l) => {
        const contract = eligible.find((c) => c.contractSymbol === l.symbol);
        return contract ? [contract.strike] : [];
      }),
    ]),
  ].sort((a, b) => a - b);
  const edit = (
    i: number,
    key: "quantity" | "premium" | "fee",
    n: number | null,
  ) => setLegs(legs.map((l, j) => (i === j ? { ...l, [key]: n } : l)));
  const complete = legs.every(
    (l) =>
      l.premium !== null && eligible.some((c) => c.contractSymbol === l.symbol),
  );
  // Every leg is priced before the line is drawn, so the reading never meets a missing premium.
  const atExpiry = t("到期标的价", "Underlying at expiry");
  const payoffReadout: ChartReadout | undefined = legs.length && complete ? {
    positions: points,
    read: (price) => payoffReading(atExpiry, price, pnl(price), currencyCode),
    marks: (price) => [{ value: pnl(price), colour: colours.brand }],
    latest: atExpiry + " " + quoteValue(spot, currencyCode, { style: "figure" }) + " · " + payoffReading(atExpiry, spot, pnl(spot), currencyCode).primary!.value,
  } : undefined;
  return (
    <div className="mt-mx-lg flex flex-col gap-mx-md">
      <div className="flex flex-wrap items-end gap-mx-md">
        <Select
          label={t("合约", "Contract")}
          searchable
          data={eligible.map((c) => ({
            value: c.contractSymbol!,
            label: `${c.side.toUpperCase()} ${quoteValue(c.strike, currencyCode, { style: "number", digits: 8 })} · ${formatCalendarDate(c.expiry, locale)}`,
          }))}
          value={selected}
          onChange={setSelected}
          w={320}
        />
        <Button
          variant="secondary"
          onClick={add}
          disabled={!selected || legs.length >= 4}
        >
          {t("加入试算", "Add to analysis")}
        </Button>
      </div>
      {legs.map((leg, i) => (
        <div key={i} className="flex flex-wrap items-end gap-mx-md">
          <span>{leg.symbol}</span>
          <FormField label={t("数量（负数为卖出）", "Quantity (negative = short)")} fieldClassName="max-w-full w-[150px]">
            {attributes => <NumericInput {...attributes}
              value={leg.quantity}
              min={-100}
              max={100}
              decimalScale={0}
              onChange={(v) => edit(i, "quantity", Number(v))}
            />}
          </FormField>
          <FormField label={`${t("假设权利金", "Assumed premium")} · ${currencyCode}`} fieldClassName="max-w-full w-[150px]">
            {attributes => <NumericInput {...attributes}
              value={leg.premium ?? ""}
              placeholder={t("请输入", "Enter premium")}
              min={0}
              onChange={(v) => edit(i, "premium", v === "" ? null : Number(v))}
            />}
          </FormField>
          <FormField label={t("每张费用", "Cost per contract")} fieldClassName="max-w-full w-[130px]">
            {attributes => <NumericInput {...attributes}
              value={leg.fee}
              min={0}
              onChange={(v) => edit(i, "fee", Number(v))}
            />}
          </FormField>
          <Button
            variant="ghost"
            onClick={() => setLegs(legs.filter((_, j) => i !== j))}
          >
            {t("移除", "Remove")}
          </Button>
        </div>
      ))}
      {legs.length > 0 && !complete && (
        <Empty
          title={t(
            "填写每个合约的权利金后查看损益",
            "Enter a premium for each contract to calculate P/L",
          )}
        />
      )}
      {legs.length > 0 && complete && (
        <>
          <OptionPlot
            label={t("到期损益试算", "Hypothetical expiration P/L")}
            readout={payoffReadout}
            option={(c) => ({
              grid: { left: 80, right: 24, top: 30, bottom: 48 },
              xAxis: { type: "value", name: quoteUnit(currencyCode).currency, axisLabel: { formatter: (v: number) => quoteValue(v, currencyCode, { style: "figure" }) } },
              yAxis: {
                type: "value",
                name: `P/L · ${currencyCode}`,
                axisLabel: { formatter: (v: number) => minus(compactTick(v, locale)) },
              },
              series: payoffSeries(c, t("到期损益", "Expiry P/L"), points.map((p) => [p, pnl(p)] as const)),
            })}
          />
          <Readings
            columns={[
              t("到期标的价", "Underlying at expiry"),
              `P/L · ${currencyCode}`,
            ]}
            rows={[0, spot * 0.75, spot, spot * 1.25, max].map((p) => [
              quoteValue(p, currencyCode),
              number(pnl(p)),
            ])}
          />
        </>
      )}
      {!legs.length && (
        <Empty
          title={t(
            "选择同一到期日的合约开始试算",
            "Select contracts sharing an expiration",
          )}
        />
      )}
      <details>
        <summary>{t("试算假设", "Payoff assumptions")}</summary>
        <p>
          {t(
            "仅计算到期内在价值，扣除填写的权利金和费用；不含提前指派、融资与税费。负数量表示卖出，裸卖 Call 的亏损没有上限。图的价格范围不代表最大风险。",
            "Expiration intrinsic value less entered premiums and costs; excludes early assignment, financing and tax. Negative quantities are short. Naked short calls have unlimited loss; the chart range is not a risk bound.",
          )}
        </p>
      </details>
    </div>
  );
}

function OptionPlot({
  option,
  label,
  height,
  readout,
}: {
  option: EChartsOption | ((colours: ChartColours) => EChartsOption);
  label: string;
  height?: number;
  readout?: ChartReadout;
}) {
  return <Plot research label={label} height={height} readout={readout}
    option={typeof option === "function" ? option : () => option} />;
}
function Readings({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const t = useCopy();
  return (
    <EvidenceTable
      label={t("精确记录", "Exact records")}
      rows={rows}
      columns={columns.map((label, i) => ({
        label,
        value: (row: string[]) => row[i],
        numeric: i > 0,
      }))}
    />
  );
}
