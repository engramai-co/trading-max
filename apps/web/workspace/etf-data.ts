import type { components } from "@/lib/api-schema";
import { api, percent } from "@/workspace/data";
import { queryOptions } from "@tanstack/react-query";

export type ETFReading = components["schemas"]["ETFReading"];
export type ETFPortfolio = components["schemas"]["ETFPortfolio"];
export type ETFDetail = components["schemas"]["ETFDetail"];
export type FundEvidence = components["schemas"]["FundEvidence"];
export type Copy = (zh: string, en: string) => string;

export function etfPortfolioQuery(runId: string, account = "total") {
  return queryOptions({
    queryKey: ["dashboard-etfs", runId, account],
    queryFn: ({ signal }) =>
      api<ETFPortfolio>(`/dashboard/etfs?runId=${encodeURIComponent(runId)}`, { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function etfDetailQuery(runId: string, isin: string) {
  return queryOptions({
    queryKey: ["dashboard-etf-detail", runId, isin],
    queryFn: ({ signal }) =>
      api<ETFDetail>(`/dashboard/etfs/${encodeURIComponent(isin)}?runId=${encodeURIComponent(runId)}`, { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function findETF(funds: readonly ETFReading[] | undefined, ticker: string, isin?: string | null) {
  const matches = funds?.filter((fund) => isin ? fund.isin === isin : fund.tickers?.includes(ticker.toUpperCase()));
  return matches?.length === 1 ? matches[0] : undefined;
}

export function signedPoints(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return (rounded > 0 ? "+" : rounded < 0 ? "−" : "") + Math.abs(rounded).toFixed(2);
}

export function trackingDisplay(reading: ETFReading | undefined, t: Copy, short = false) {
  const tracking = reading?.tracking;
  const missing = t("暂无", "Unavailable");
  const value = tracking?.differencePp;
  const display = tracking?.state === "incomparable" ? t("不可比", "Incomparable")
    : value == null ? missing : signedPoints(value) + (short ? "" : " pp");
  const name = t("一年跟踪差", "1-year tracking difference");
  const basis = t("份额净值总回报减去发行商披露的指数总回报", "Share-class NAV total return minus issuer-published benchmark total return");
  const period = tracking?.periodEnd ?? t("期末未提供", "Period end unavailable");
  const status = tracking?.state === "stale" ? t("已过期", "Stale") : undefined;
  const hedge = (value: string | null | undefined) => value === "unhedged"
    ? t("未对冲", "Unhedged") : value ?? t("对冲未确认", "Hedging unconfirmed");
  const details = tracking ? [
    reading?.issuer, tracking.evidence?.sourceUrl, reading?.indexName,
    `${tracking.currency ?? "—"} · ${hedge(tracking.navHedging)} / ${tracking.benchmarkCurrency ?? "—"} · ${hedge(tracking.benchmarkHedging)}`,
    period,
  ].filter(Boolean) : [];
  return {
    display, status,
    description: [name + " " + display, basis, ...details, status].filter(Boolean).join(" · "),
  };
}

export function overlapDisplay(reading: ETFReading | undefined, t: Copy) {
  const overlap = reading?.overlap;
  const display = overlap?.value == null ? t("暂无", "Unavailable") : percent(overlap.value, false, 0);
  const status = overlap?.state === "stale" ? t("日期未验证", "Dates unverified") : undefined;
  const missing = t("暂无", "Unavailable");
  const fundCoverage = overlap?.fundCoverage == null ? missing : percent(overlap.fundCoverage);
  const restCoverage = overlap?.restCoverage == null ? missing : percent(overlap.restCoverage);
  const otherDates = overlap?.restHoldingsDates?.join(", ") || missing;
  const fundDate = overlap?.fundHoldingsDate ?? missing;
  return {
    display, status, fundCoverage, restCoverage,
    description: [
      t("组合重叠", "Portfolio overlap") + " " + display,
      t("按相同证券逐项取较小权重再相加；其余为 Invest 与 ISA 的直接和穿透持仓，排除同一份额类别、现金和 CFD。",
        "Sum of the smaller weights for identical securities. The rest includes direct and look-through Invest and ISA positions, excluding the same share class, cash, and CFDs."),
      overlap && [
        t("覆盖率 · 基金 / 其余组合", "Coverage · fund / rest") + `: ${fundCoverage} / ${restCoverage}`,
        t("持仓日期 · 基金 / 其余基金", "Holdings dates · fund / other funds") + `: ${fundDate} / ${otherDates}`,
        t("账户快照", "Account snapshot") + `: ${overlap.portfolioAsOf ?? missing}`,
      ].join(" · "),
      reading?.issuer, reading?.evidence?.holdings_date?.sourceUrl, status,
    ].filter(Boolean).join(" · "),
  };
}

export function fieldEvidence(label: string, value: string, evidence: FundEvidence | undefined, t: Copy) {
  return [label + " " + value, evidence?.sourceUrl, evidence?.effectiveAt ?? t("日期未披露", "Effective date undisclosed"),
    evidence?.fetchedAt && t("读取于 ", "Fetched ") + evidence.fetchedAt].filter(Boolean).join(" · ");
}
