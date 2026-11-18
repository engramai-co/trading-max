"use client";

import { useLocale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import { formatCalendarDate, formatCompactCurrency } from "@/ui/formatters";
import { currency, number, percent, tone } from "@/workspace/data";
import { Metric, Panel, useCopy } from "./foundation";
import type { Preview } from "./research-facts";

export type ModelReading = {
  initial: Preview;
  result: Preview;
  source: string;
  edited: boolean;
  stale: boolean;
  busy: boolean;
};

function ReverseReading({ result, retry, refreshing }: {
  result?: Preview;
  retry?: () => void;
  refreshing?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const metric = result?.reverseMetric ?? "revenue-growth";
  const inputs = result?.scenarios.base?.inputs;
  if (metric === "year-five-revenue" && result) {
    return <Metric label={t("现价隐含的第五年营收", "Year-five revenue implied by price")}
      value={formatCompactCurrency(result.reverseValue, locale, result.basis.currency)}
      note={<>
        {t("目标利润率", "Target margin")} {percent(result.reverseInputs?.targetFcfMargin)}
        {" · "}{t("退出倍数", "Exit multiple")} {number(result.reverseInputs?.exitFcfMultiple, 1)}×
        {result.reverseReason === "positive-target-and-multiple-required" &&
          <span className="mx-reverse-status">{t("利润率与倍数须为正", "Margin and multiple must be positive")}</span>}
        {retry && !refreshing ? <span className="mx-reverse-status" role="alert">
          {t("未能按最新价格重算", "Not revalued at the latest price")}{" "}
          <button type="button" className="mx-text-link" onClick={retry}>{t("重试", "Retry")}</button>
        </span> : refreshing && <span className="mx-reverse-status" role="status">{t("计算中…", "Calculating…")}</span>}
      </>}
      help={t("报告期营收为零。按前五年无中期分配和给定退出倍数计算所需营收。",
        "Reported revenue was zero. The required revenue assumes no interim distributions and applies the exit multiple to year-five earnings.")} />;
  }
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

export function ValuationReadout({ data, preview, reading, retry, refreshing }: {
  data: ResearchLensSnapshot;
  preview?: Preview;
  reading?: ModelReading;
  retry?: () => void;
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
      note={<span>{[status, modelSource, base && result && result.horizon + t(" 年", "Y")].filter(Boolean).join(" · ")}</span>} />
  </Panel>;
}
