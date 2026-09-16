"use client";
import { researchPriceQuery } from "./research-queries";

import type { ResearchLensSnapshot } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { ratingSummary, targetSnapshot } from "./analyst-data";
import { Plot } from "./charts";
import {
  currency,
  inRange,
  number,
  numeric,
  object,
  objects,
  percent,
  str,
  tone,
} from "./data";
import { Help, Panel, Tag, useCopy } from "./foundation";

function ConsensusGauge({
  score,
  label,
}: {
  score: number | null;
  label: string;
}) {
  const point = (angle: number, radius: number) => [
    110 + Math.cos(angle) * radius,
    111 - Math.sin(angle) * radius,
  ];
  const angle = (((score ?? 3) - 0.5) / 5) * Math.PI;
  const tip = point(angle, 67);
  return (
    <svg
      className="mx-consensus-gauge"
      viewBox="0 0 220 130"
      role="img"
      aria-label={label}
    >
      {[4, 3, 2, 1, 0].map((rating, index) => {
        const from = point(Math.PI - (index * Math.PI) / 5 - 0.025, 91);
        const to = point(Math.PI - ((index + 1) * Math.PI) / 5 + 0.025, 91);
        return (
          <path
            key={rating}
            d={`M ${from.join(" ")} A 91 91 0 0 1 ${to.join(" ")}`}
            fill="none"
            stroke={`var(--mx-rating-${rating})`}
            strokeWidth="15"
          />
        );
      })}
      {score != null && (
        <>
          <line
            x1="110"
            y1="111"
            x2={tip[0]}
            y2={tip[1]}
            stroke="var(--mx-ink)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="110" cy="111" r="5" fill="var(--mx-ink)" />
        </>
      )}
    </svg>
  );
}

export function AnalystExpectations({ data, revision }: { data: ResearchLensSnapshot; revision?: string | null }) {
  const t = useCopy();
  const analyst = object(data.analyst),
    market = object(data.market);
  const summary = ratingSummary(objects(analyst.recommendations));
  const targets = targetSnapshot(
    object(analyst.priceTargets),
    data.context?.quote.price ?? market.spot ?? data.valuation?.spot,
  );
  const code = data.context?.quote.currency ?? str(market.currency);
  const median = targets.rows.find((row) => row.key === "median")!;
  const ratingLabels = [
    t("强烈买入", "Strong buy"),
    t("买入", "Buy"),
    t("持有", "Hold"),
    t("卖出", "Sell"),
    t("强烈卖出", "Strong sell"),
  ];
  const targetLabels = {
    low: t("低位", "Low"),
    mean: t("均值", "Mean"),
    median: t("中位数", "Median"),
    high: t("高位", "High"),
  };
  const providerKey = str(analyst.providerRecommendationKey)
    .toLowerCase()
    .replaceAll("_", "");
  const providerIndex = [
    "strongbuy",
    "buy",
    "hold",
    "sell",
    "strongsell",
  ].indexOf(providerKey);
  const consensus =
    providerIndex >= 0
      ? ratingLabels[providerIndex]
      : t("评级分布", "Rating distribution");
  const historicalPeriod = /^-\d+m$/.test(summary.period)
    ? Math.abs(parseInt(summary.period))
    : null;
  const prices = useQuery(researchPriceQuery(data.ticker, revision ?? data.runId));
  const currencyMatches = prices.data?.currency === code;
  const points = currencyMatches
    ? inRange(prices.data?.points ?? [], "1Y")
    : [];
  const priceDate = points.at(-1)?.date.slice(0, 10);
  const spotDate = str(market.asOf).slice(0, 10);
  const values = [
    ...points.map((p) => numeric(p.close)),
    targets.spot,
    ...targets.rows.map((r) => r.value),
  ].filter((v): v is number => v != null);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maxValue - minValue) * 0.14, maxValue * 0.04);
  const axis = {
    min: Math.max(0, minValue - padding),
    max: maxValue + padding,
  };
  const priceProblem = prices.isPending
    ? t("正在加载价格…", "Loading prices…")
    : prices.isError
      ? t("历史价格加载失败", "Price history failed to load")
      : !prices.data?.points.length
        ? t("暂无历史价格", "Price history unavailable")
        : !prices.data.currency
          ? t("历史价格币种未提供", "Historical currency unavailable")
          : !currencyMatches
            ? t("历史价格币种不同", "Historical currency differs")
            : null;
  return (
    <Panel className="mx-expectations">
      <div className="mx-expectations-grid">
        <section
          className="mx-consensus"
          aria-label={t("分析师共识", "Analyst consensus")}
        >
          <div className="mx-expectations-heading">
            <div className="mx-panel-title">
              <h2>{t("分析师共识", "Analyst consensus")}</h2>
              <Help label={t("分析师共识", "Analyst consensus")}>
                {t(
                  "评级由强烈买入到卖出按 1–5 分加权，指针表示平均分，文字取最接近的评级。人数只统计评级记录，不代表目标价样本数。任何档位缺失时，不推算共识。",
                  "Ratings are weighted from 1 (strong buy) to 5 (sell). The pointer shows the average; the label uses the nearest rating. Counts describe recommendation records, not price-target coverage. Missing categories leave consensus unavailable.",
                )}
              </Help>
            </div>
          </div>
          <div className="mx-consensus-verdict">
            <strong
              style={{
                color:
                  summary.score == null
                    ? undefined
                    : `var(--mx-rating-${Math.round(summary.score) - 1})`,
              }}
            >
              {consensus}
            </strong>
            <span>
              {summary.complete
                ? summary.knownTotal + t(" 项评级", " ratings")
                : t("评级覆盖不完整", "Incomplete coverage")}
              {historicalPeriod != null &&
                " · " + historicalPeriod + t(" 个月前", " months ago")}
            </span>
          </div>
          <ConsensusGauge
            score={summary.score}
            label={
              summary.score == null
                ? consensus
                : consensus + " · " + number(summary.score, 2) + " / 5"
            }
          />
          <ul
            className="mx-rating-distribution"
            aria-label={t("评级分布", "Rating distribution")}
          >
            {summary.counts.map((count, index) => (
              <li key={ratingLabels[index]}>
                <span>{ratingLabels[index]}</span>
                <span className="mx-rating-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${summary.knownTotal ? ((count ?? 0) / summary.knownTotal) * 100 : 0}%`,
                      background: `var(--mx-rating-${index})`,
                    }}
                  />
                </span>
                <strong>{number(count, 0)}</strong>
              </li>
            ))}
          </ul>
        </section>
        <section
          className="mx-target-context"
          aria-label={t("价格与市场预期", "Price and market expectations")}
        >
          <div className="mx-expectations-heading">
            <div className="mx-panel-title">
              <h2>{t("价格与市场预期", "Price & expectations")}</h2>
              <Help label={t("价格与市场预期", "Price & expectations")}>
                <p>
                  {t(
                    "左侧是已记录的近 12 个月价格，右侧是分析师目标价快照，两者使用同一价格刻度。机构目标价通常参考未来约 12 个月，本快照没有统一到期日，也不提供逐月预测。",
                    "The left shows up to 12 months of recorded prices. The right shows current analyst targets on the same price scale. Targets typically look about 12 months ahead, but this snapshot has no common expiry and supplies no monthly forecast.",
                  )}
                </p>
                <p>
                  {t(
                    "中位数是排序后的中间值；均值是平均值，较易受极端目标影响。涨跌幅按目标价 ÷ 现价 − 1 计算。目标价与模型估值是独立参考。",
                    "The median is the middle target; the mean is the average and is more sensitive to extremes. Changes use target ÷ spot − 1. Analyst targets are independent of model valuations.",
                  )}
                </p>
              </Help>
            </div>
            <Tag>{code}</Tag>
          </div>
          <div className="mx-target-summary">
            <div>
              <span className="mx-metric-label">
                {t("目标价中位数", "Median price target")}
              </span>
              <strong>{currency(median.value, code, 2)}</strong>
            </div>
            <span
              className={
                median.change == null ? "mx-muted" : "mx-" + tone(median.change)
              }
            >
              <b>{percent(median.change, true)}</b>{" "}
              {t("相对现价", "versus spot")}
            </span>
          </div>
          <div className="mx-target-chart-heading">
            <span>{t("近 12 个月价格", "12-month price history")}</span>
            <span>{t("目标价快照", "Target snapshot")}</span>
          </div>
          <div className="mx-target-chart">
            {priceProblem && (
              <div className="mx-price-context-status" role="status">
                <span>{priceProblem}</span>
                {prices.isError && (
                  <button type="button" onClick={() => void prices.refetch()}>
                    {t("重试", "Retry")}
                  </button>
                )}
              </div>
            )}
            <Plot
              research
              label={t(
                "历史价格与分析师目标区间，共用价格刻度，目标快照无时间轴",
                "Historical prices and analyst target range on one price scale; target snapshot has no time axis",
              )}
              height={232}
              option={(c) => ({
                grid: [
                  { left: 40, right: "39%", top: 16, bottom: 28 },
                  { left: "72%", right: 12, top: 16, bottom: 28 },
                ],
                xAxis: [
                  {
                    type: "category",
                    data: points.map((p) => p.date.slice(0, 10)),
                    boundaryGap: false,
                    axisLabel: {
                      color: c.axis,
                      fontSize: 10,
                      showMinLabel: true,
                      showMaxLabel: true,
                      hideOverlap: true,
                      formatter: (v: string) => v.slice(2, 7),
                    },
                    axisTick: { show: false },
                    axisLine: { lineStyle: { color: c.border } },
                  },
                  { type: "value", gridIndex: 1, min: 0, max: 1, show: false },
                ],
                yAxis: [
                  {
                    type: "value",
                    ...axis,
                    splitNumber: 3,
                    axisLabel: {
                      color: c.axis,
                      fontSize: 10,
                      formatter: (v: number) => number(v, v < 10 ? 1 : 0),
                    },
                    splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                  },
                  { type: "value", gridIndex: 1, ...axis, show: false },
                ],
                series: [
                  {
                    type: "line",
                    name: t("收盘价", "Close"),
                    data: points.map((p) => p.close),
                    symbol: "none",
                    lineStyle: { color: c.brand, width: 2 },
                    itemStyle: { color: c.brand },
                    connectNulls: false,
                    markLine:
                      targets.spot == null
                        ? undefined
                        : {
                            silent: true,
                            symbol: "none",
                            label: { show: false },
                            lineStyle: {
                              color: c.axis,
                              type: "dotted",
                              opacity: 0.55,
                            },
                            data: [{ yAxis: targets.spot }],
                          },
                  },
                  {
                    type: "line",
                    xAxisIndex: 1,
                    yAxisIndex: 1,
                    data: targets.range?.map((value) => [0.12, value]) ?? [],
                    symbol: "none",
                    lineStyle: { color: c.secondary, width: 10, opacity: 0.25 },
                    silent: true,
                  },
                  ...targets.rows
                    .filter((row) => row.key !== "mean" && row.value != null)
                    .map((row) => ({
                      type: "scatter" as const,
                      xAxisIndex: 1,
                      yAxisIndex: 1,
                      name: targetLabels[row.key],
                      data: [[0.12, row.value]],
                      symbol: row.key === "median" ? "diamond" : "circle",
                      symbolSize: row.key === "median" ? 12 : 7,
                      itemStyle: {
                        color:
                          row.key === "median"
                            ? c.text
                            : row.change != null && row.change < 0
                              ? c.negative
                              : c.positive,
                        opacity: 1,
                      },
                      label: {
                        show: true,
                        position: "right" as const,
                        distance: 9,
                        color: c.text,
                        fontSize: 10,
                        lineHeight: 15,
                        formatter:
                          targetLabels[row.key] + "\n" + number(row.value, 2),
                      },
                      tooltip: {
                        trigger: "item" as const,
                        formatter:
                          targetLabels[row.key] +
                          ": " +
                          currency(row.value, code, 2),
                      },
                      labelLayout: { hideOverlap: true },
                    })),
                ],
              })}
            />
          </div>
          <div className="mx-target-dateline">
            <span>
              {t("现价", "Spot")}{" "}
              <strong>{currency(targets.spot, code, 2)}</strong>
            </span>
            <span>
              {spotDate || t("价格日期未提供", "Price date unavailable")}
            </span>
          </div>
          <div
            className="mx-target-values"
            role="region"
            aria-label={t("目标价明细", "Price target details")}
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{code}</th>
                  {targets.rows.map((row) => (
                    <th
                      scope="col"
                      key={row.key}
                      className={
                        row.key === "median" ? "mx-target-primary" : undefined
                      }
                    >
                      {targetLabels[row.key]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t("目标价", "Target")}</th>
                  {targets.rows.map((row) => (
                    <td
                      key={row.key}
                      className={
                        row.key === "median" ? "mx-target-primary" : undefined
                      }
                    >
                      {number(row.value, 2)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t("相对现价", "vs spot")}</th>
                  {targets.rows.map((row) => (
                    <td
                      key={row.key}
                      className={
                        row.change == null
                          ? "mx-muted"
                          : "mx-" + tone(row.change)
                      }
                    >
                      {percent(row.change, true)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {targets.rows.some((row) => row.value == null) && (
            <p className="mx-target-availability">
              {t("部分目标价未提供", "Some price targets are unavailable")}
            </p>
          )}
          {priceDate && spotDate && priceDate !== spotDate && (
            <p className="mx-target-availability">
              {t("历史价格截至 ", "Price history through ") + priceDate}
            </p>
          )}
        </section>
      </div>
    </Panel>
  );
}
