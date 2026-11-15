"use client";

import type { components } from "@/lib/api-schema";
import dynamic from "next/dynamic";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDeltaPercent, formatNumber, formatPercent } from "@/ui/formatters";
import { Notice, useCopy } from "./foundation";
import { RiskChart } from "./research-index-chart";

type DailyTracking = components["schemas"]["DailyTracking"];
const Plot = dynamic(() => import("./charts").then((module) => module.Plot));

export function DailyTrackingSeries({ data, hedgeUnconfirmed }: {
  data?: DailyTracking | null; hedgeUnconfirmed: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const points = data?.points ?? [];
  const dates = points.map(({ date }) => date);
  const summary = data?.summary;
  if (hedgeUnconfirmed || data?.state === "hedged-comparison-unconfirmed") {
    return <>
      <Notice tone="warn">
        {t("对冲口径未确认。英镑对冲净值与美元净回报指数分开展示。", "Hedged comparison unconfirmed. GBP hedged NAV and the USD net-return index are shown separately.")}
      </Notice>
      {data && points.length > 0 && <div className="mx-index-research-risk">
        <RawSeries dates={dates} values={points.map((row) => row.nav ?? null)}
          title={t("份额净值", "Share-class NAV") + " · " + data.navCurrency} />
        <RawSeries dates={dates} values={points.map((row) => row.benchmarkLevel ?? null)}
          title={t("基准指数", "Benchmark index") + " · " + data.benchmarkCurrency} />
      </div>}
    </>;
  }
  if (!data) return null;
  return <>
    {summary && <div className="mx-index-research-provenance">
      <span>{data.navCurrency} · {t("份额净值总回报 / 指数净回报", "NAV total return / index net return")}</span>
      <span>{formatCalendarDate(summary.firstDate, locale)} – {formatCalendarDate(summary.lastDate, locale)}</span>
      <span>{t("共同观察", "Common observations")} {formatNumber(summary.commonObservations, locale)}</span>
      <span>{t("有效日收益差", "Daily return differences")} {formatNumber(summary.dailyReturnObservations, locale)}</span>
      <span>{t("年化跟踪差", "Annualised tracking difference")} {formatDeltaPercent(summary.trackingDifference, locale, 2)}</span>
      <span>{t("年化跟踪误差", "Annualised tracking error")} {formatPercent(summary.trackingError, locale, 2)}</span>
    </div>}
    <div className="mx-index-research-risk">
      <RiskChart dates={dates} values={points.map((row) => row.cumulativeDifference ?? null)}
        title={t("累计跟踪差", "Cumulative tracking difference")} primary />
      <RiskChart dates={dates} values={points.map((row) => row.rollingTrackingError ?? null)}
        title={t("滚动一年跟踪误差", "Rolling one-year tracking error")} />
    </div>
  </>;
}

function RawSeries({ dates, values, title }: { dates: string[]; values: (number | null)[]; title: string }) {
  const { locale } = useLocale();
  return <section className="mx-index-research-risk-chart" aria-label={title}>
    <h3>{title}</h3>
    <Plot label={title} height={170}
      readPoint={(i) => [formatCalendarDate(dates[i], locale), formatNumber(values[i], locale, { maximumFractionDigits: 2 })].join(" · ")}
      option={(colours) => ({
        animation: false,
        grid: { top: 15, left: 61, right: 14, bottom: 28 },
        xAxis: { type: "category", data: dates, axisLabel: { formatter: (day: string) => day.slice(0, 4) } },
        yAxis: { type: "value", scale: true, splitNumber: 4 },
        tooltip: { trigger: "axis" },
        series: [{ type: "line", data: values, showSymbol: false, lineStyle: { color: colours.brand } }],
      })} />
  </section>;
}


export function PremiumDiscountSeries({ data }: {
  data?: components["schemas"]["FundPremiumDiscount"] | null;
}) {
  const t = useCopy();
  if (!data?.points.length) return null;
  return <RiskChart title={t("溢折价 · 同一时点", "Premium / discount · matched timestamps")}
    dates={data.points.map((row) => row.at)} values={data.points.map((row) => row.premium)} />;
}
