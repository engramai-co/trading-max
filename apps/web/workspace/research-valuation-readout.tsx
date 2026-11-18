"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import { formatCalendarDate, formatCompactCurrency } from "@/ui/formatters";
import { currency, number, percent, tone } from "@/workspace/data";
import { Metric, Panel, useCopy } from "./foundation";
import { ValuationFloorNote } from "./valuation-floor-note";
import type { Preview } from "./research-facts";

export type ModelReading = {
  initial: Preview;
  result: Preview;
  source: string;
  edited: boolean;
  stale: boolean;
  busy: boolean;
};

type Refresh = { retry?: () => Promise<unknown>; refreshing?: boolean };

function RevenueReading({ result, retry, refreshing }: { result: Preview } & Refresh) {
  const t = useCopy();
  const { locale } = useLocale();
  const value = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState<"idle" | "pending" | "complete">("idle");
  const showRetry = Boolean(retry) || attempt === "pending";
  useLayoutEffect(() => {
    if (attempt === "complete" && !refreshing && !retry && button.current === document.activeElement)
      value.current?.focus({ preventScroll: true });
  }, [attempt, refreshing, retry]);

  const label = t("现价隐含的第五年营收", "Year-five revenue implied by price");
  const amount = formatCompactCurrency(result.reverseValue, locale, result.basis.currency);
  return <Metric label={label}
    value={<span ref={value} tabIndex={-1} role="group" aria-label={label + " · " + amount}>
      {amount}
    </span>}
    note={<>
      {t("目标利润率", "Target margin")} {percent(result.reverseInputs?.targetFcfMargin)}
      {" · "}{t("退出倍数", "Exit multiple")} {number(result.reverseInputs?.exitFcfMultiple, 1)}×
      {result.reverseReason === "positive-target-and-multiple-required" &&
        <span className="mx-reverse-status">{t("利润率与倍数须为正", "Margin and multiple must be positive")}</span>}
      <span className="mx-reverse-feedback">
        {(showRetry || attempt === "complete") &&
          <span className="mx-reverse-status" role={showRetry ? "alert" : undefined} data-settled={!showRetry || undefined}>
            {t("未能按最新价格重算", "Not revalued at the latest price")}{" "}
            <button ref={button} type="button" className="mx-text-link" aria-disabled={refreshing || attempt === "pending" || !retry}
              onClick={async () => {
                if (!retry || refreshing || attempt === "pending") return;
                setAttempt("pending");
                await retry();
                setAttempt("complete");
              }}>{t("重试", "Retry")}</button>
          </span>}
        {refreshing && !showRetry && <span className="mx-reverse-status" role="status">{t("计算中…", "Calculating…")}</span>}
      </span>
    </>}
    help={t("报告期营收为零。按前五年无中期分配和给定退出倍数计算所需营收。",
      "Reported revenue was zero. The required revenue assumes no interim distributions and applies the exit multiple to year-five earnings.")} />;
}

function ReverseReading({ result, retry, refreshing }: { result?: Preview } & Refresh) {
  const t = useCopy();
  const metric = result?.reverseMetric ?? "revenue-growth";
  const inputs = result?.scenarios.base?.inputs;
  if (metric === "year-five-revenue" && result)
    return <RevenueReading result={result} retry={retry} refreshing={refreshing} />;
  const roe = metric === "initial-roe";
  const margin = metric === "target-margin";
  const label = roe ? t("现价隐含的第一年 ROE", "Year-one ROE implied by price")
    : margin ? t("现价隐含的目标利润率", "Target margin implied by price")
      : t("价格隐含增长", "Price-implied growth");
  const assumption = roe ? inputs?.initialRoe : margin ? inputs?.targetFcfMargin : inputs?.revenueCagr;
  const limits = result?.reverseLimits ?? (metric === "revenue-growth" ? [-0.3, 0.8] : null);
  const bound = result?.reverseMetric ? result.reverseBound : result?.impliedGrowthBound;
  const value = result?.reverseMetric ? result.reverseValue : result?.impliedGrowth;
  const reason = result?.reverseMetric ? result.reverseReason : result?.impliedGrowthReason;
  const unavailable = reason === "opening-cash-required-for-burn"
    ? t("缺少期初现金", "Opening cash unavailable")
    : reason ? t("无法确定唯一解", "No unique estimate") : null;
  return <Metric label={label} value={limits && bound === "above" ? ">" + percent(limits[1])
    : limits && bound === "below" ? "<" + percent(limits[0]) : percent(value)}
    note={[t("模型假设", "Model assumption") + " " + percent(assumption), unavailable].filter(Boolean).join(" · ")}
    help={t("固定中性情景的其他假设，求解让模型价值等于现价的输入值。",
      "The input that makes the model value equal the current price, holding the other base assumptions fixed.")}
    helpBasis={limits && t("求解区间", "Search range") + " " + percent(limits[0]) + " – " + percent(limits[1])} />;
}

export function ValuationReadout({ data, preview, reading, retry, refreshing, withheldReason }: {
  data: ResearchLensSnapshot;
  preview?: Preview;
  reading?: ModelReading;
  withheldReason?: string;
  retry?: () => Promise<unknown>;
  refreshing?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const history = data.trailingPeHistory;
  const latest = history?.points.at(-1);
  const rank = history?.distribution?.latestPercentile;
  const result = reading?.result ?? preview;
  const base = result?.scenarios.base;
  const percentile = latest?.pe != null && rank != null ? t("历史分位 P", "Percentile P") + number(rank * 100, 0) : null;
  const status = reading?.busy ? t("计算中…", "Calculating…") : reading?.stale ? t("上次结果", "Previous result") : null;
  const modelSource = reading?.edited ? t("本次调整", "Current edit") : reading?.source;
  return <Panel className="mx-valuation-readout">
    <Metric label={t("滚动 P/E", "Trailing P/E")} value={latest?.pe == null ? "—" : number(latest.pe, 1) + "×"}
      note={[percentile, latest && formatCalendarDate(latest.date, locale)].filter(Boolean).join(" · ")} />
    <ReverseReading result={result} retry={retry} refreshing={refreshing} />
    <Metric label={t("中性情景", "Base scenario")} value={base && result ? <>
      {currency(base.value, result.basis.currency, 2)}
      {base.upside != null && <small className={"mx-metric-change mx-" + tone(base.upside)}>{percent(base.upside, true)}</small>}
    </> : "—"}
      note={<>
        <span>{[status, modelSource, base && result && result.horizon + t(" 年", "Y"), withheldReason].filter(Boolean).join(" · ")}</span>
        <ValuationFloorNote adjustment={base?.equityFloorAdjustment} />
      </>} />
  </Panel>;
}
