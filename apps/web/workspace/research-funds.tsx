"use client";
import type { components } from "@/lib/api-schema";
import type { ResearchLensSnapshot } from "@/lib/types";
import { Select, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Plot } from "./charts";
import { api, number, object, percent, safeUrl, str } from "./data";
import { EvidenceTable } from "./evidence-table";
import {
  Empty,
  Facts,
  Metric,
  Panel,
  Pending,
  QueryError,
  Segments,
  TextLink,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
type Fund = components["schemas"]["FundResearch"];
export function FundWorkbench({
  data,
  overview = false,
  onExplore,
}: {
  data: ResearchLensSnapshot;
  overview?: boolean;
  onExplore: (ticker: string) => void;
}) {
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const [search, setSearch] = useState("");
  const mode = params.get("fundMode") ?? "holdings",
    group = params.get("fundGroup") ?? "industry";
  const query = useQuery({
    queryKey: ["research-fund", data.ticker, data.runId],
    queryFn: () =>
      api<Fund>(`/research/${encodeURIComponent(data.ticker)}/fund`),
    staleTime: 3600000,
    retry: false,
  });
  if (query.isPending) return <Pending />;
  if (query.isError) return <QueryError retry={query.refetch} />;
  const fund = query.data,
    snapshot = fund.holdings,
    info = object(object(data.fundamentals).metrics);
  const holdings = [...(snapshot?.holdings ?? [])].sort(
    (a, b) => b.weightPct - a.weightPct,
  );
  const rows = holdings.filter((h) =>
    (h.name + " " + h.ticker + " " + h.isin)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const grouped =
    group === "country" ? snapshot?.countryWeights : snapshot?.industryWeights;
  const buckets = Object.entries(grouped ?? {}).sort((a, b) => b[1] - a[1]);
  const annual = fund.annualReturns ?? [];
  return (
    <>
      {overview && (
        <Panel
          title={t("基金概况", "Fund profile")}
          action={
            safeUrl(fund.sourceUrl ?? "") ? (
              <a
                className="mx-text-link"
                href={fund.sourceUrl!}
                target="_blank"
                rel="noreferrer"
              >
                {t("发行商原文", "Issuer source")} ↗
              </a>
            ) : undefined
          }
        >
          <div className="mx-metric-grid">
            <Metric
              label={t("总费用率", "Total expense ratio")}
              value={percent(fund.expenseRatio, false, 2)}
            />
            <Metric
              label={t("份额类别资产", "Share-class assets")}
              value={fund.totalAssetsLabel || "—"}
              note={fund.totalAssetsAsOf ?? undefined}
            />
            <Metric
              label={t("收益分配", "Income use")}
              value={fund.incomeUse || "—"}
            />
            <Metric
              label={t("持仓数", "Holdings")}
              value={holdings.length ? number(holdings.length, 0) : "—"}
            />
          </div>
          <h3 style={{ marginTop: 28 }}>
            {fund.indexName ||
              str(info.category) ||
              t("投资策略", "Investment strategy")}
          </h3>
          {Boolean(info.longBusinessSummary) && (
            <details>
              <summary>{t("投资目标", "Investment objective")}</summary>
              <p>{str(info.longBusinessSummary)}</p>
            </details>
          )}
          <Facts
            rows={[
              ["ISIN", fund.isin || "—"],
              [
                t("份额币种", "Share-class currency"),
                fund.shareCurrency || "—",
              ],
              [
                t("基金基础币种", "Fund base currency"),
                fund.baseCurrency || "—",
              ],
              [
                t("交易报价币种", "Listing quote currency"),
                data.context?.quote.currency || "—",
              ],
              [
                t("复制方式", "Replication"),
                [fund.replication, fund.methodology]
                  .filter(Boolean)
                  .join(" · ") || "—",
              ],
              [t("注册地", "Domicile"), fund.domicile || "—"],
              [t("成立日期", "Inception"), fund.inception || "—"],
              [
                t("汇率对冲", "Currency hedging"),
                fund.hedging || t("未提供", "Not provided"),
              ],
            ]}
          />
          <TextLink
            href={`/research?ticker=${encodeURIComponent(data.ticker)}&view=fundamentals`}
          >
            {t("持仓与跟踪表现", "Holdings & tracking performance")}
          </TextLink>
        </Panel>
      )}
      {!overview && (
        <Panel
          title={t("基金持仓与跟踪", "Fund holdings & tracking")}
          action={
            <Segments
              label={t("基金研究", "Fund research")}
              value={mode}
              onChange={(v) => update({ fundMode: v })}
              options={[
                { value: "holdings", label: t("持仓", "Holdings") },
                { value: "tracking", label: t("跟踪表现", "Tracking") },
              ]}
            />
          }
        >
          {mode === "tracking" ? (
            <>
              <h3>
                {fund.indexName || t("基准尚未确认", "Benchmark not confirmed")}
              </h3>
              {annual.length ? (
                <>
                  <Plot
                    research
                    label={t(
                      "NAV 与基准总回报",
                      "NAV and benchmark total returns",
                    )}
                    option={(c) => ({
                      legend: {
                        top: 0,
                        data: ["NAV", t("基准", "Benchmark")],
                        textStyle: { color: c.text },
                      },
                      grid: { top: 44, left: 66, right: 24, bottom: 40 },
                      xAxis: {
                        type: "category",
                        data: annual.map((r) => r.year),
                      },
                      yAxis: {
                        type: "value",
                        name: "%",
                        axisLabel: { formatter: (v: number) => percent(v) },
                      },
                      tooltip: {
                        valueFormatter: (v) =>
                          percent(typeof v === "number" ? v : null, true, 1),
                      },
                      series: [
                        {
                          name: "NAV",
                          type: "bar",
                          data: annual.map((r) => r.navReturn),
                          itemStyle: { color: c.brand },
                        },
                        {
                          name: t("基准", "Benchmark"),
                          type: "bar",
                          data: annual.map((r) => r.benchmarkReturn),
                          itemStyle: { color: c.secondary },
                        },
                      ],
                    })}
                  />
                  <EvidenceTable
                    label={t("年度跟踪差异", "Annual tracking difference")}
                    rows={[...annual].reverse()}
                    columns={[
                      { label: t("年度", "Year"), value: (r) => r.year },
                      {
                        label: `NAV · ${fund.returnCurrency}`,
                        value: (r) => percent(r.navReturn, true),
                        numeric: true,
                      },
                      {
                        label: t("指数", "Index"),
                        value: (r) => percent(r.benchmarkReturn, true),
                        numeric: true,
                      },
                      {
                        label: t("差异 · pp", "Difference · pp"),
                        value: (r) => number(r.trackingDifference * 100, 1),
                        numeric: true,
                      },
                    ]}
                  />
                  <details>
                    <summary>{t("口径与精度", "Basis & precision")}</summary>
                    <p>{fund.returnBasis}</p>
                    <p>
                      {t(
                        "跟踪误差需要同币种的日度 NAV 与指数总回报历史，当前源未提供；不使用交易价格代替。",
                        "Tracking error requires daily NAV and index total-return histories in the same currency. These histories are unavailable from the current source.",
                      )}
                    </p>
                  </details>
                </>
              ) : (
                <Empty
                  title={t(
                    "尚无匹配的 NAV 与指数总回报数据",
                    "Matching NAV and index total returns are unavailable",
                  )}
                />
              )}
            </>
          ) : (
            <>
              {!holdings.length ? (
                <Empty
                  title={t("发行商持仓尚不可用", "Issuer holdings unavailable")}
                />
              ) : (
                <>
                  <div className="mx-toolbar">
                    <time>{snapshot?.asOf}</time>
                    <span>
                      {t("已披露权重", "Disclosed weight")}{" "}
                      {number(
                        holdings.reduce((sum, h) => sum + h.weightPct, 0),
                        2,
                      )}
                      %
                    </span>
                    <span>
                      Top 10 ·{" "}
                      {number(
                        holdings
                          .slice(0, 10)
                          .reduce((sum, h) => sum + h.weightPct, 0),
                        2,
                      )}
                      %
                    </span>
                    <Select
                      aria-label={t("持仓分组", "Holding group")}
                      value={group}
                      onChange={(v) => update({ fundGroup: v })}
                      data={[
                        { value: "industry", label: t("行业", "Sector") },
                        { value: "country", label: t("地域", "Country") },
                      ]}
                    />
                  </div>
                  {buckets.length > 0 && (
                    <Plot
                      research
                      label={
                        group === "country"
                          ? t("地域配置", "Country allocation")
                          : t("行业配置", "Sector allocation")
                      }
                      height={Math.max(250, Math.min(buckets.length, 12) * 30)}
                      option={(c) => ({
                        grid: { left: 155, right: 50, top: 10, bottom: 30 },
                        xAxis: {
                          type: "value",
                          min: 0,
                          axisLabel: { formatter: (v: number) => `${v}%` },
                        },
                        yAxis: {
                          type: "category",
                          inverse: true,
                          data: buckets.slice(0, 12).map(([name]) => name),
                        },
                        tooltip: { valueFormatter: (value) => number(value, 2) + "%" },
                        series: [
                          {
                            type: "bar",
                            barMaxWidth: 12,
                            data: buckets
                              .slice(0, 12)
                              .map(([, weight]) => weight),
                            itemStyle: { color: c.brand },
                            label: {
                              show: true,
                              position: "right",
                              formatter: (p) => number(p.value, 1) + "%",
                            },
                          },
                        ],
                      })}
                    />
                  )}
                  <TextInput
                    aria-label={t("筛选基金持仓", "Filter fund holdings")}
                    placeholder={t(
                      "公司、代码或 ISIN",
                      "Company, symbol or ISIN",
                    )}
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    mb="md"
                  />
                  <EvidenceTable
                    label={t("完整持仓", "Holdings")}
                    rows={rows}
                    columns={[
                      {
                        label: t("持仓", "Holding"),
                        value: (h) =>
                          h.ticker &&
                          h.assetClass.toLowerCase().includes("equit") ? (
                            <button
                              className="mx-text-link"
                              onClick={() => onExplore(h.ticker)}
                            >
                              {h.name} · {h.ticker}
                            </button>
                          ) : (
                            h.name
                          ),
                      },
                      {
                        label: t("权重", "Weight"),
                        value: (h) => number(h.weightPct, 3) + "%",
                        numeric: true,
                      },
                      {
                        label: t("行业", "Sector"),
                        value: (h) => h.industry || "—",
                      },
                      {
                        label: t("地域", "Country"),
                        value: (h) => h.country || "—",
                      },
                      {
                        label: t("资产类型", "Asset type"),
                        value: (h) => h.assetClass,
                      },
                    ]}
                  />
                  <TextLink href={`/holdings?view=lookthrough`}>
                    {t(
                      "查看组合穿透与重叠敞口",
                      "Portfolio look-through & overlapping exposure",
                    )}
                  </TextLink>
                </>
              )}
            </>
          )}
          {fund.state === "stale" && (
            <p role="status">
              {t(
                "发行商更新失败，保留上次成功数据。",
                "Issuer refresh failed; last successful data retained.",
              )}
            </p>
          )}
          {safeUrl(fund.sourceUrl ?? "") && (
            <a
              className="mx-source-link"
              href={fund.sourceUrl!}
              target="_blank"
              rel="noreferrer"
            >
              {t("发行商来源", "Issuer source")} ↗
            </a>
          )}
        </Panel>
      )}
    </>
  );
}
