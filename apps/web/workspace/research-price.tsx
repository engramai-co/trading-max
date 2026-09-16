"use client";
import { researchPriceQuery } from "./research-queries";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Checkbox, Drawer, Group, Modal, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ECharts, SeriesOption } from "echarts";
import { useRef, useState } from "react";
import { Legend, Plot } from "./charts";
import {
  compact,
  inRange,
  number,
  object,
  objects,
  percent,
  str,
  type Range,
} from "./data";
import { EvidenceTable } from "./evidence-table";
import {
  Empty,
  Facts,
  Panel,
  Pending,
  QueryError,
  Segments,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";

const intervals = ["15m", "60m", "1d", "1wk"];
export function PriceHistory({
  ticker,
  runId,
  technical = false,
  context,
}: {
  ticker: string;
  runId: string;
  technical?: boolean;
  context?: ResearchLensSnapshot;
}) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const ranges = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "2Y", "ALL"];
  const range = ranges.includes(params.get("priceRange") ?? "")
    ? params.get("priceRange")!
    : "3M";
  const requested = params.get("interval");
  const interval =
    requested && intervals.includes(requested)
      ? requested
      : range === "1D" || range === "5D"
        ? "15m"
        : range === "1M" || range === "3M"
          ? "60m"
          : "1d";
  const style = params.get("priceStyle") ?? "line",
    scale = params.get("priceScale") ?? "linear";
  const averages =
    params.get("ma") === "off" ? false : params.get("ma") === "on" || technical;
  const selectedMa = params.get("highlightMa"),
    rsi = params.get("rsi") === "on",
    macd = params.get("macd") === "on";
  const comparison = params.get("benchmark") ?? "none";
  const [full, setFull] = useState(false),
    [events, setEvents] = useState(false);
  const chart = useRef<ECharts | null>(null);
  const [zoom, setZoom] = useState({ start: 0, end: 100 });
  const zoomKey = `tm-research-zoom:${ticker}:${range}:${interval}`;
  const savedZoom = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(zoomKey) ?? "null");
      if (
        saved &&
        Number.isFinite(saved.start) &&
        Number.isFinite(saved.end) &&
        saved.start >= 0 &&
        saved.end <= 100 &&
        saved.end > saved.start
      )
        return saved as { start: number; end: number };
    } catch {
      /* Storage can be disabled; chart interaction still works. */
    }
    return zoom;
  };
  const query = useQuery(researchPriceQuery(ticker, runId, interval));
  const benchmark = useQuery({
    ...researchPriceQuery(comparison, runId, interval),
    enabled: comparison !== "none",
    retry: false,
  });
  const all = query.data?.points ?? [],
    sessions = [...new Set(all.map((p) => p.date.slice(0, 10)))];
  const points =
    range === "1D" || range === "5D"
      ? all.filter((p) =>
          sessions
            .slice(range === "1D" ? -1 : -5)
            .includes(p.date.slice(0, 10)),
        )
      : inRange(all, range as Range);
  const isIntraday = query.data?.actualInterval.endsWith("m"),
    dates = points.map((p) => p.date);
  const formatDate = (date: string) =>
    isIntraday
      ? new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: query.data?.timezone ?? "UTC",
        }).format(new Date(date))
      : date.slice(0, 10);
  const benchmarkPoints = new Map(
    benchmark.data?.points.map((p) => [p.date, p]) ?? [],
  );
  const matched = points.filter((p) => benchmarkPoints.has(p.date));
  const comparable =
    comparison !== "none" &&
    benchmark.data?.currency === query.data?.currency &&
    benchmark.data?.actualInterval === query.data?.actualInterval &&
    matched.length > 1;
  const normalized = scale === "percent" || comparable,
    anchor = comparable ? matched[0] : points[0];
  const benchmarkAnchor = benchmarkPoints.get(anchor?.date)?.close;
  const candle =
    style === "candles" &&
    !normalized &&
    points.every((p) => p.open != null && p.high != null && p.low != null);
  const value = (price: number | null | undefined) =>
    price == null ? null : normalized ? price / anchor.close - 1 : price;
  const markers = (query.data?.tradeMarkers ?? []).filter((m) =>
    dates.some((d) => d.slice(0, 10) === m.date.slice(0, 10)),
  );
  const corporate = (query.data?.events ?? []).filter((e) =>
    dates.some((d) => d.slice(0, 10) === String(e.date).slice(0, 10)),
  );
  const earnings = objects(object(context?.analyst).earningsEvents).filter(
    (e) => dates.some((d) => d.slice(0, 10) === str(e.date).slice(0, 10)),
  );
  const reset = () => {
    try {
      sessionStorage.removeItem(zoomKey);
    } catch {
      /* Optional view preference. */
    }
    setZoom({ start: 0, end: 100 });
    chart.current?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  };
  const toggleFull = (next: boolean) => {
    const current = (
      chart.current?.getOption().dataZoom as
        | { start?: number; end?: number }[]
        | undefined
    )?.[0];
    if (current?.start != null && current.end != null)
      setZoom({ start: current.start, end: current.end });
    setFull(next);
  };
  const content = (
    <>
      <div className="mx-price-tools">
        <Segments
          label={t("价格区间", "Price range")}
          value={range}
          onChange={(v) => {
            update({ priceRange: v, interval: null });
            reset();
          }}
          options={ranges.map((v) => ({
            value: v,
            label: v === "ALL" ? t("全部记录", "Available") : v,
          }))}
        />
        <Group gap="xs">
          <Select
            w={104}
            aria-label={t("行情粒度", "Bar interval")}
            value={interval}
            onChange={(v) => {
              update({ interval: v });
              reset();
            }}
            data={intervals.map((v, i) => ({
              value: v,
              label: [
                t("15 分钟", "15 min"),
                t("1 小时", "1 hour"),
                t("日线", "Daily"),
                t("周线", "Weekly"),
              ][i],
            }))}
          />
          <Segments
            label={t("价格样式", "Price style")}
            value={style}
            onChange={(v) => update({ priceStyle: v })}
            options={[
              { value: "line", label: t("线", "Line") },
              { value: "candles", label: t("K 线", "Candles") },
            ]}
          />
          <Select
            w={110}
            aria-label={t("纵轴", "Price axis")}
            value={scale}
            onChange={(v) => update({ priceScale: v })}
            data={[
              { value: "linear", label: t("线性", "Linear") },
              { value: "log", label: t("对数", "Log") },
              { value: "percent", label: t("涨跌幅", "Return %") },
            ]}
          />
          <Button variant="default" size="compact-sm" onClick={reset}>
            {t("恢复范围", "Reset zoom")}
          </Button>
          <Button
            variant="default"
            size="compact-sm"
            onClick={() => toggleFull(!full)}
          >
            {full
              ? t("退出完整图表", "Close full chart")
              : t("完整图表", "Full chart")}
          </Button>
        </Group>
      </div>
      <div className="mx-price-layers">
        <Group gap="lg">
          <Checkbox
            size="xs"
            label={t("均线", "Averages")}
            checked={averages}
            onChange={(e) =>
              update({
                ma: e.currentTarget.checked ? "on" : "off",
                highlightMa: null,
              })
            }
          />
          <Checkbox
            size="xs"
            label="RSI 14"
            checked={rsi}
            onChange={(e) =>
              update({ rsi: e.currentTarget.checked ? "on" : null })
            }
          />
          <Checkbox
            size="xs"
            label="MACD 12/26/9"
            checked={macd}
            onChange={(e) =>
              update({ macd: e.currentTarget.checked ? "on" : null })
            }
          />
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => setEvents(true)}
          >
            {t("事件记录", "Events")} ({markers.length + corporate.length + earnings.length})
          </Button>
        </Group>
        <Select
          w={165}
          aria-label={t("基准对比", "Benchmark comparison")}
          value={comparison}
          onChange={(v) => update({ benchmark: v === "none" ? null : v })}
          data={[
            { value: "none", label: t("加入对比", "Compare with") },
            { value: "SPY", label: "SPY · S&P 500 ETF" },
            { value: "QQQ", label: "QQQ · Nasdaq 100 ETF" },
            { value: "VT", label: "VT · Global stocks" },
          ]}
        />
      </div>
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : !points.length ? (
        <Empty
          title={t("当前区间没有行情", "No price history in this range")}
        />
      ) : (
        <>
          {query.data.coverageReason && (
            <p role="status">
              {t(
                "该粒度暂不可用，当前显示已有日线。",
                "This interval is unavailable. Available daily history is shown.",
              )}
            </p>
          )}
          {comparison !== "none" && !comparable && (
            <p role="status">
              {benchmark.isPending
                ? t("正在载入比较行情…", "Loading comparison…")
                : t(
                    "当前记录缺少同币种、同粒度的重合区间。",
                    "No matching currency, interval and common coverage for comparison.",
                  )}
            </p>
          )}
          <Plot
            research
            controller={chart}
            onZoom={(instance) => {
              const current = (
                instance.getOption().dataZoom as
                  | { start?: number; end?: number }[]
                  | undefined
              )?.[0];
              if (current?.start != null && current.end != null) {
                try {
                  sessionStorage.setItem(
                    zoomKey,
                    JSON.stringify({ start: current.start, end: current.end }),
                  );
                } catch {
                  /* Optional view preference. */
                }
              }
            }}
            label={`${ticker} · ${t("价格、成交量和技术指标", "Price, volume and indicators")}`}
            height={
              full
                ? Math.max(
                    450,
                    typeof window === "undefined"
                      ? 650
                      : window.innerHeight - 280,
                  )
                : 410 + (rsi ? 125 : 0) + (macd ? 125 : 0)
            }
            option={(c) => {
              const panes = [
                "price",
                "volume",
                ...(rsi ? ["rsi"] : []),
                ...(macd ? ["macd"] : []),
              ];
              const extra = panes.length - 2,
                mainHeight = 67 - extra * 12;
              const positions = [
                { top: 3, height: mainHeight },
                { top: 6 + mainHeight, height: 10 },
                ...Array.from({ length: extra }, (_, i) => ({
                  top: 20 + mainHeight + i * 16,
                  height: 13,
                })),
              ];
              const series: SeriesOption[] = [
                candle
                  ? {
                      type: "candlestick",
                      name: ticker,
                      data: points.map((p) => [
                        p.open!,
                        p.close,
                        p.low!,
                        p.high!,
                      ]),
                      itemStyle: {
                        color: c.positive,
                        color0: c.negative,
                        borderColor: c.positive,
                        borderColor0: c.negative,
                      },
                    }
                  : {
                      type: "line",
                      name: ticker,
                      data: points.map((p) =>
                        comparable && p.date < anchor.date
                          ? null
                          : value(p.close),
                      ),
                      showSymbol: points.length === 1,
                      connectNulls: false,
                      lineStyle: { width: 2, color: c.brand },
                      areaStyle: normalized
                        ? undefined
                        : { color: c.brand, opacity: 0.04 },
                    },
              ];
              if (comparable && benchmarkAnchor)
                series.push({
                  type: "line",
                  name: comparison,
                  showSymbol: false,
                  connectNulls: false,
                  data: points.map((p) => {
                    const b = benchmarkPoints.get(p.date);
                    return p.date < anchor.date || !b
                      ? null
                      : b.close / benchmarkAnchor - 1;
                  }),
                  lineStyle: { color: c.secondary, width: 1.6 },
                });
              if (averages)
                (["sma20", "sma50", "sma200"] as const).forEach((key, i) =>
                  series.push({
                    type: "line",
                    name: key.toUpperCase(),
                    showSymbol: false,
                    connectNulls: false,
                    data: points.map((p) => value(p[key])),
                    lineStyle: {
                      color: [c.accent, c.secondary, c.axis][i],
                      width: selectedMa === key ? 2.5 : 1.2,
                      opacity: selectedMa && selectedMa !== key ? 0.3 : 1,
                    },
                  }),
                );
              series.push({
                type: "bar",
                name: t("成交量", "Volume"),
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: points.map((p, i) => ({
                  value: p.volume,
                  itemStyle: {
                    color:
                      i && p.close < points[i - 1].close ? c.negative : c.brand,
                    opacity: 0.45,
                  },
                })),
                barMaxWidth: 14,
              });
              if (rsi) {
                const index = panes.indexOf("rsi");
                series.push({
                  type: "line",
                  name: "RSI 14",
                  xAxisIndex: index,
                  yAxisIndex: index,
                  data: points.map((p) => p.rsi14),
                  connectNulls: false,
                  showSymbol: false,
                  lineStyle: { color: c.secondary, width: 1.4 },
                  markLine: {
                    silent: true,
                    symbol: "none",
                    lineStyle: { color: c.axis, type: "dashed", opacity: 0.5 },
                    data: [{ yAxis: 30 }, { yAxis: 70 }],
                    label: { show: false },
                  },
                });
              }
              if (macd) {
                const index = panes.indexOf("macd");
                series.push(
                  ...(["macd", "macdSignal"] as const).map(
                    (key, i): SeriesOption => ({
                      type: "line",
                      name: i ? t("信号", "Signal") : "MACD",
                      xAxisIndex: index,
                      yAxisIndex: index,
                      data: points.map((p) => p[key]),
                      connectNulls: false,
                      showSymbol: false,
                      lineStyle: { color: i ? c.accent : c.brand, width: 1.4 },
                    }),
                  ),
                  {
                    type: "bar",
                    name: t("MACD 差值", "MACD histogram"),
                    xAxisIndex: index,
                    yAxisIndex: index,
                    data: points.map((p) => ({
                      value: p.macdHistogram,
                      itemStyle: {
                        color:
                          (p.macdHistogram ?? 0) < 0 ? c.negative : c.positive,
                        opacity: 0.5,
                      },
                    })),
                    barMaxWidth: 10,
                  },
                );
              }
              const eventDay = params.get("eventDate");
              const eventIndex =
                eventDay &&
                eventDay >= dates[0]?.slice(0, 10) &&
                eventDay <= dates.at(-1)!.slice(0, 10)
                  ? dates.findIndex((d) => d.slice(0, 10) >= eventDay)
                  : -1;
              if (
                eventIndex >= 0 &&
                series[0] &&
                (series[0].type === "line" || series[0].type === "candlestick")
              ) {
                series[0].markLine = {
                  silent: true,
                  symbol: "none",
                  lineStyle: { color: c.axis, type: "dashed" },
                  label: {
                    show: true,
                    formatter: eventDay ?? "",
                    position: "insideEndTop",
                  },
                  data: [{ xAxis: dates[eventIndex] }],
                };
              }
              return {
                grid: positions.map((p) => ({
                  left: 64,
                  right: 24,
                  top: p.top + "%",
                  height: p.height + "%",
                })),
                axisPointer: { link: [{ xAxisIndex: "all" }] },
                tooltip: {
                  formatter: (input) => {
                    const entry = (Array.isArray(input) ? input : [input])[0];
                    const p = points[entry?.dataIndex];
                    return !p
                      ? ""
                      : [
                          formatDate(p.date) + " · " + query.data.currency,
                          `${t("收盘", "Close")}  ${number(p.close, 2)}`,
                          ...(candle
                            ? [
                                `O ${number(p.open, 2)}   H ${number(p.high, 2)}   L ${number(p.low, 2)}`,
                              ]
                            : []),
                          `${t("成交量", "Volume")}  ${number(p.volume, 0)}`,
                          ...(rsi ? [`RSI 14  ${number(p.rsi14, 2)}`] : []),
                          ...(macd
                            ? [
                                `MACD  ${number(p.macd, 3)}   ${t("信号", "Signal")} ${number(p.macdSignal, 3)}`,
                              ]
                            : []),
                        ].join("\n");
                  },
                },
                xAxis: panes.map((_, i) => ({
                  type: "category",
                  data: dates,
                  gridIndex: i,
                  boundaryGap: candle,
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: {
                    show: i === panes.length - 1,
                    hideOverlap: true,
                    color: c.axis,
                    formatter: (d: string) =>
                      isIntraday ? formatDate(d) : d.slice(5),
                  },
                })),
                yAxis: panes.map((pane, i) => ({
                  type:
                    pane === "price" && scale === "log" && !normalized
                      ? "log"
                      : "value",
                  gridIndex: i,
                  scale: true,
                  min: pane === "rsi" ? 0 : undefined,
                  max: pane === "rsi" ? 100 : undefined,
                  splitNumber: pane === "price" ? 4 : 2,
                  name:
                    pane === "price"
                      ? ""
                      : pane === "volume"
                        ? t("量", "Vol")
                        : pane.toUpperCase(),
                  nameTextStyle: { color: c.axis, fontSize: 10 },
                  axisLabel: {
                    color: c.axis,
                    formatter: (v: number) =>
                      pane === "price" && normalized ? percent(v) : compact(v),
                  },
                  splitLine: {
                    show: pane !== "volume",
                    lineStyle: { color: c.grid, type: "dashed" },
                  },
                })),
                dataZoom: [
                  {
                    type: "inside",
                    xAxisIndex: panes.map((_, i) => i),
                    ...savedZoom(),
                    zoomOnMouseWheel: "ctrl",
                    moveOnMouseWheel: false,
                  },
                  {
                    type: "slider",
                    xAxisIndex: panes.map((_, i) => i),
                    bottom: 0,
                    height: 18,
                    showDetail: false,
                    borderColor: c.grid,
                    ...savedZoom(),
                  },
                ],
                series,
              };
            }}
          />
          <Legend
            items={[
              { label: ticker },
              ...(comparable
                ? [{ label: comparison, colour: "var(--mx-chart-2)" }]
                : []),
            ]}
          />
          <div className="mx-chart-footer">
            <span>
              {formatDate(points[0].date)} → {formatDate(points.at(-1)!.date)}
            </span>
            <span>
              {query.data.currency} · {query.data.actualInterval} ·{" "}
              {query.data.timezone ?? ""}
            </span>
          </div>
          {markers.length + corporate.length + earnings.length > 0 && (
            <div
              className="mx-event-track"
              aria-label={t("事件时间轴", "Event timeline")}
            >
              {[
                ...markers.map((m) => ({
                  date: m.date,
                  label: m.kind,
                  id: "",
                })),
                ...corporate.map((e) => ({
                  date: String(e.date),
                  id: "",
                  label:
                    e.kind === "split"
                      ? t("拆股", "Split")
                      : t("分红", "Dividend"),
                })),
                ...earnings.map((e) => ({
                  date: str(e.date),
                  label: t("财报", "Earnings"),
                  id: str(e.id),
                })),
              ]
                .sort((a, b) => a.date.localeCompare(b.date))
                .slice(-14)
                .map((e, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      e.id
                        ? update({
                            view: "analyst",
                            analystView: "events",
                            eventId: e.id,
                            eventDate: e.date,
                          })
                        : setEvents(true)
                    }
                  >
                    <time>{e.date.slice(5, 10)}</time>
                    <strong>{e.label}</strong>
                  </button>
                ))}
            </div>
          )}
          <details className="mx-chart-data">
            <summary>
              {t("行情与指标明细", "Price & indicator records")}
            </summary>
            <EvidenceTable
              key={range + interval}
              label={t("价格记录", "Price records")}
              rows={[...points].reverse()}
              columns={[
                { label: t("时间", "Time"), value: (p) => formatDate(p.date) },
                ...(
                  [
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "rsi14",
                    "macd",
                    "macdSignal",
                  ] as const
                ).map((key, i) => ({
                  label: [
                    "Open",
                    "High",
                    "Low",
                    "Close",
                    "Volume",
                    "RSI 14",
                    "MACD",
                    "Signal",
                  ][i],
                  numeric: true,
                  value: (p: (typeof points)[number]) =>
                    number(p[key], key === "volume" ? 0 : 2),
                })),
              ]}
            />
          </details>
        </>
      )}
    </>
  );
  return (
    <>
      <Panel
        title={t("价格与技术", "Price & technicals")}
        help={t(
          "行情为拆股及分红调整后价格。均线与指标按当前 K 线粒度计算：RSI 14 使用 Wilder 平滑，MACD 为 12/26/9。交易和公司事件另列于时间轴，不把当日收盘价当成交价。比较按同币种和共同起点归一化。",
          "Prices are split and dividend adjusted. Indicators use the selected bar interval: Wilder RSI 14, MACD 12/26/9. Trades and company events have a separate track; a close is not an execution price. Comparisons share currency and starting time.",
        )}
      >
        {!full && content}
      </Panel>
      <Modal
        fullScreen
        opened={full}
        onClose={() => toggleFull(false)}
        title={ticker + " · " + t("完整图表", "Full chart")}
      >
        <div className="mx-full-chart">{full && content}</div>
      </Modal>
      <Drawer
        position="right"
        size="lg"
        opened={events}
        onClose={() => setEvents(false)}
        title={t("事件记录", "Events")}
      >
        <div className="mx-note-list">
          {!markers.length && !corporate.length && !earnings.length ? (
            <Empty title={t("区间内没有记录", "No records in this range")} />
          ) : (
            <>
              {markers.map((m, i) => (
                <article key={i}>
                  <h3>
                    {m.date.slice(0, 10)} · {m.kind}
                  </h3>
                  <Facts
                    rows={[
                      [t("买入数量", "Bought"), number(m.buyQuantity, 4)],
                      [
                        t("买入成交均价", "Average execution · buys"),
                        number(m.buyAveragePrice, 2),
                      ],
                      [t("卖出数量", "Sold"), number(m.sellQuantity, 4)],
                      [
                        t("卖出成交均价", "Average execution · sells"),
                        number(m.sellAveragePrice, 2),
                      ],
                      [t("账户", "Accounts"), m.accounts.join(" · ")],
                    ]}
                  />
                </article>
              ))}
              {corporate.map((e, i) => (
                <article key={"event" + i}>
                  <h3>
                    {String(e.date).slice(0, 10)} ·{" "}
                    {e.kind === "split"
                      ? t("拆股", "Split")
                      : t("分红", "Dividend")}
                  </h3>
                  <p>
                    {number(e.value, 4)} {String(e.currency ?? "")}
                  </p>
                </article>
              ))}
              {earnings.map((e, i) => <article key={"earnings" + i}><h3>{String(e.date)} · {t("财报", "Earnings")}</h3><Button variant="subtle" onClick={() => { setEvents(false); update({view:"analyst", analystView:"events", eventId: String(e.id), eventDate: String(e.date)}); }}>{t("查看实际与预期", "Reported results & estimates")}</Button></article>)}
            </>
          )}
        </div>
      </Drawer>
    </>
  );
}
