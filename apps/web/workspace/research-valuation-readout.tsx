"use client";

import { quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import { formatCalendarDate } from "@/ui/formatters";
import { number, percent, tone } from "@/workspace/data";
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

export function ValuationReadout({ data, reading }: { data: ResearchLensSnapshot; reading?: ModelReading }) {
  const t = useCopy();
  const { locale } = useLocale();
  const history = data.trailingPeHistory;
  const latest = history?.points.at(-1);
  const rank = history?.distribution?.latestPercentile;
  const result = reading?.result;
  const base = result?.scenarios.base;
  const implied = result?.impliedGrowthBound === "above" ? ">80%"
    : result?.impliedGrowthBound === "below" ? "<−30%" : percent(result?.impliedGrowth);
  const percentile = latest?.pe != null && rank != null ? t("历史分位 P", "Percentile P") + number(rank * 100, 0) : null;
  const status = reading?.busy ? t("计算中…", "Calculating…") : reading?.stale ? t("上次结果", "Previous result") : null;
  const modelSource = reading?.edited ? t("本次调整", "Current edit") : reading?.source;
  return <Panel className="mx-valuation-readout">
    <Metric label={t("滚动 P/E", "Trailing P/E")} value={latest?.pe == null ? "—" : number(latest.pe, 1) + "×"}
      note={[percentile, latest && formatCalendarDate(latest.date, locale)].filter(Boolean).join(" · ")} />
    <Metric label={t("价格隐含增长", "Price-implied growth")} value={implied}
      note={t("模型假设", "Model assumption") + " " + percent(base?.inputs.revenueCagr)}
      help={t("固定中性情景的其他假设，求解让模型价值等于现价的前五年营收增长率。",
        "The annual revenue growth for years 1–5 that matches the current price with the other base assumptions held fixed.")} />
    <Metric label={t("中性情景", "Base scenario")} value={base && result ? <>
      {quoteValue(base.value, result.basis.currency)}
      {base.upside != null && <small className={"mx-metric-change mx-" + tone(base.upside)}>{percent(base.upside, true)}</small>}
    </> : "—"}
      note={<span>{[status, modelSource, result && result.horizon + t(" 年", "Y")].filter(Boolean).join(" · ")}</span>} />
  </Panel>;
}
