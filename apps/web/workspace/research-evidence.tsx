"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Group, MultiSelect, Select, TextInput } from "@mantine/core";
import { useState } from "react";
import { Plot } from "./charts";
import {
  compact,
  number,
  numeric,
  object,
  objects,
  percent,
  safeUrl,
  str,
} from "./data";
import { Empty, Facts, Metric, Panel, Segments, useCopy } from "./foundation";
import { useRouteState } from "./route-state";
import { chartName, chartNumber } from "./research-chart-format";
import { dividendSummary } from "./research-dividends";
import { EvidenceTable } from "./evidence-table";
import { categoricalChartColours } from "@/ui/charts/palette";

export function BusinessSegments({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const { params, update } = useRouteState("push");
  const trend = params.get("segmentView") === "trend";
  const shares = params.get("segmentScale") === "share";
  const indexed = trend && params.get("segmentScale") === "indexed";
  const source = objects(object(data.researchEvidence).segments);
  const frequency = ["quarterly", "semiannual", "irregular"].includes(
    params.get("frequency") ?? "",
  )
    ? params.get("frequency")!
    : "annual";
  const axes = [
    ...new Set(
      source.filter((s) => s.kind === frequency).map((s) => str(s.axis)),
    ),
  ];
  const axis = axes.includes(params.get("segmentAxis") ?? "")
    ? params.get("segmentAxis")!
    : (axes.find((a) => a.includes("ProductOrService")) ?? axes[0]);
  const rows = source.filter((s) => s.kind === frequency && s.axis === axis);
  const periods = [...new Set(rows.map((s) => str(s.periodEnd)))].sort();
  const requestedPeriod = data.financialFacts?.periods?.find(
    (p) => p.id === params.get("period"),
  );
  const end = requestedPeriod
    ? periods.find(
        (p) =>
          p === requestedPeriod.actualEnd || p === requestedPeriod.providerEnd,
      )
    : periods.at(-1);
  const members = [...new Set(rows.map((s) => str(s.member)))].sort();
  const selectedMembers = (
    params.get("segmentMembers") ??
    params.get("segmentMember") ??
    ""
  )
    .split("|")
    .filter((member) => members.includes(member));
  const visibleMembers = selectedMembers.length ? selectedMembers : members;
  const label = (member: string) =>
    str(rows.find((s) => s.member === member)?.name) || member;
  const values = (period: string, member: string) =>
    rows.find((s) => s.periodEnd === period && s.member === member);
  const periodReconciles = (end: string) => {
    const group = rows.filter((s) => s.periodEnd === end);
    const total = numeric(group[0]?.reportedTotal);
    return (
      total != null &&
      total > 0 &&
      group.every(
        (s) =>
          numeric(s.value) != null &&
          s.currency === group[0].currency &&
          s.reportedTotal === group[0].reportedTotal,
      ) &&
      Math.abs(
        group.reduce((sum, s) => sum + (numeric(s.value) ?? 0), 0) - total,
      ) <=
        total * 0.001
    );
  };
  const anchorPeriod = periods.find(
    (period) =>
      periodReconciles(period) &&
      visibleMembers.every(
        (member) => (numeric(values(period, member)?.value) ?? 0) > 0,
      ),
  );
  const selected = rows.filter((s) => s.periodEnd === end);
  const reconciled = end != null && periodReconciles(end);
  const prior = rows.filter(
    (s) =>
      numeric(s.fiscalYear) === (numeric(selected[0]?.fiscalYear) ?? 0) - 1 &&
      str(s.periodEnd).slice(5, 7) === String(end).slice(5, 7),
  );
  const groupLabel = (a: string) =>
    a.includes("ProductOrService")
      ? t("产品与服务", "Products & services")
      : a.toLowerCase().includes("geograph")
        ? t("地域", "Geography")
        : t("经营分部", "Operating segments");
  if (!source.length)
    return (
      <Panel title={t("业务与地域", "Business & geography")}>
        <Empty
          title={t(
            "该公司的分部披露尚不可用",
            "Segment disclosures are not available",
          )}
        />
      </Panel>
    );
  if (!end || !axes.length)
    return (
      <Panel title={t("业务与地域", "Business & geography")}>
        <Empty
          title={t(
            "该财期暂无分部披露",
            "No segment disclosure for this period",
          )}
        />
      </Panel>
    );
  return (
    <Panel
      title={groupLabel(axis ?? "")}
      action={
        <Select
          aria-label={t("分部维度", "Segment dimension")}
          value={axis}
          onChange={(v) =>
            update({
              segmentAxis: v,
              segmentMember: null,
              segmentMembers: null,
            })
          }
          data={axes.map((a) => ({ value: a, label: groupLabel(a) }))}
        />
      }
    >
      <div className="mx-toolbar">
        <Segments
          label={t("分部图表", "Segment chart")}
          value={trend ? "trend" : "composition"}
          onChange={(v) =>
            update({
              segmentView: v === "trend" ? v : null,
              segmentMember: null,
              segmentMembers: null,
              segmentScale:
                v !== "trend" && indexed ? null : params.get("segmentScale"),
            })
          }
          options={[
            { value: "composition", label: t("规模与构成", "Size & mix") },
            { value: "trend", label: t("分部趋势", "Segment trends") },
          ]}
        />
        <span>
          {end} · {str(selected[0]?.currency)}
        </span>
        <Segments
          label={t("分部显示方式", "Segment display")}
          value={indexed ? "indexed" : shares ? "share" : "amount"}
          onChange={(v) => update({ segmentScale: v === "amount" ? null : v })}
          options={[
            { value: "amount", label: t("金额", "Amount") },
            { value: "share", label: t("占比", "Share") },
            ...(trend
              ? [{ value: "indexed", label: t("期初 = 100", "Start = 100") }]
              : []),
          ]}
        />
      </div>
      {trend && (
        <MultiSelect
          aria-label={t("选择分部", "Select segments")}
          placeholder={
            selectedMembers.length ? undefined : t("全部分部", "All segments")
          }
          value={selectedMembers}
          onChange={(v) =>
            update({
              segmentMembers: v.length ? v.join("|") : null,
              segmentMember: null,
            })
          }
          data={members.map((member) => ({
            value: member,
            label: label(member),
          }))}
          clearable
          searchable
          mb="md"
        />
      )}
      {indexed && !anchorPeriod && (
        <p role="status">
          {t(
            "所选分部没有可比较的共同起点",
            "The selected segments have no comparable common start",
          )}
        </p>
      )}
      {reconciled && (
        <Plot
          label={groupLabel(axis ?? "")}
          height={325}
          option={(c) => ({
            legend: { bottom: 0, type: "scroll", textStyle: { color: c.text } },
            grid: { top: 30, left: 65, right: 20, bottom: 75 },
            xAxis: {
              type: "category",
              data: periods,
              axisLabel: { color: c.axis },
            },
            yAxis: {
              type: "value",
              max: shares ? 1 : undefined,
              axisLabel: {
                color: c.axis,
                formatter: (n: number) =>
                  indexed ? number(n, 0) : shares ? percent(n) : compact(n),
              },
              splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
            },
            tooltip: {
              formatter: (input) => {
                const entries = Array.isArray(input) ? input : [input];
                return [
                  String(entries[0]?.name ?? "") +
                    " · " +
                    (indexed
                      ? t("期初 = 100", "Start = 100")
                      : shares
                        ? "%"
                        : str(selected[0]?.currency)),
                  ...entries.map(
                    (e) =>
                      `${chartName(String(e.seriesName))}   ${shares ? percent(e.value, false, 2) : chartNumber(e.value)}`,
                  ),
                ].join("\n");
              },
            },
            series: visibleMembers.map((member) => ({
              type: trend ? "line" : "bar",
              stack: trend ? undefined : "revenue",
              name: label(member),
              connectNulls: false,
              smooth: false,
              showSymbol: periods.length < 10,
              itemStyle: {
                color: [
                  c.brand,
                  c.accent,
                  c.secondary,
                  c.negative,
                  c.positive,
                  categoricalChartColours[3],
                  c.axis,
                  c.warning,
                ][members.indexOf(member) % 8],
              },
              barMaxWidth: 85,
              data: periods.map((p) =>
                periodReconciles(p)
                  ? indexed
                    ? anchorPeriod &&
                      p >= anchorPeriod &&
                      numeric(values(p, member)?.value) != null
                      ? (Number(values(p, member)?.value) /
                          Number(values(anchorPeriod, member)?.value)) *
                        100
                      : null
                    : numeric(values(p, member)?.[shares ? "share" : "value"])
                  : null,
              ),
            })),
          })}
        />
      )}
      {!reconciled && (
        <p role="status">
          {t(
            "分部总额尚未与合并收入对齐",
            "Segment totals have not reconciled to consolidated revenue",
          )}
        </p>
      )}
      <div
        className="mx-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t("分部收入明细", "Segment revenue details")}
      >
        <table className="mx-financial-table">
          <thead>
            <tr>
              <th>{t("分部", "Segment")}</th>
              <th>{t("收入", "Revenue")}</th>
              <th>{t("占比", "Share")}</th>
              <th>{t("同比", "YoY")}</th>
              <th>{t("增长贡献", "Growth contribution")}</th>
            </tr>
          </thead>
          <tbody>
            {selected.map((s) => {
              const before = prior.find((p) => p.member === s.member);
              const current = numeric(s.value);
              const previous = numeric(before?.value);
              const previousTotal = numeric(before?.reportedTotal);
              return (
                <tr key={str(s.id)}>
                  <th>
                    <button
                      className="mx-inline-control"
                      aria-pressed={selectedMembers.includes(str(s.member))}
                      onClick={() =>
                        update({
                          segmentView: "trend",
                          segmentMember: null,
                          segmentMembers:
                            selectedMembers.length === 1 &&
                            selectedMembers[0] === s.member
                              ? null
                              : str(s.member),
                        })
                      }
                    >
                      {str(s.name)}
                    </button>
                  </th>
                  <td>
                    <span title={number(current, 0) + " " + str(s.currency)}>
                      {compact(current)}
                    </span>
                  </td>
                  <td>{reconciled ? percent(s.share) : "—"}</td>
                  <td>
                    {current != null && previous != null && previous > 0
                      ? percent(current / previous - 1, true)
                      : "—"}
                  </td>
                  <td>
                    {current != null &&
                    previous != null &&
                    previousTotal != null &&
                    previousTotal > 0
                      ? number(
                          ((current - previous) / previousTotal) * 100,
                          2,
                        ) + " pp"
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="mx-detail-records">
        <summary>{t("分部历史明细", "Segment history details")}</summary>
        <EvidenceTable
          rows={rows}
          label={t("分部历史明细", "Segment history details")}
          columns={[
            { label: t("期间", "Period"), value: (r) => str(r.periodEnd) },
            { label: t("分部", "Segment"), value: (r) => str(r.name) },
            {
              label: t("收入", "Revenue"),
              value: (r) => number(r.value, 0),
              numeric: true,
            },
            { label: t("货币", "Currency"), value: (r) => str(r.currency) },
            { label: t("披露日期", "Filed"), value: (r) => str(r.publishedAt) },
            {
              label: t("来源", "Source"),
              value: (r) =>
                safeUrl(str(r.url)) ? (
                  <a
                    href={safeUrl(str(r.url))}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("原始披露", "Original filing")} ↗
                  </a>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </details>
      {Boolean(safeUrl(str(selected[0]?.url))) && (
        <a
          className="mx-source-link"
          href={safeUrl(str(selected[0].url))}
          target="_blank"
          rel="noreferrer"
        >
          {t("查看原始披露", "Read original filing")} ↗
        </a>
      )}
    </Panel>
  );
}

export function CompanyOwnership({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const info = object(object(data.fundamentals).metrics);
  return (
    <div className="mx-grid">
      <Panel title={t("股权结构", "Ownership")}>
        <Facts
          rows={[
            [
              t("内部人持股", "Insider ownership"),
              percent(info.heldPercentInsiders),
            ],
            [
              t("机构持股", "Institutional ownership"),
              percent(info.heldPercentInstitutions),
            ],
            [t("流通股数", "Public float"), compact(info.floatShares)],
            [
              t("总股数", "Shares outstanding"),
              compact(info.sharesOutstanding),
            ],
          ]}
        />
      </Panel>
      <Panel
        title={t("空头持仓", "Short interest")}
        help={t(
          "空头比例以流通股为分母；回补天数为短仓数量与平均日成交量之比，不代表实际回补计划。",
          "Short percent uses float as its denominator. Days to cover compares short interest with average daily volume; it is not a forecast of covering.",
        )}
        action={
          numeric(info.dateShortInterest) != null ? (
            <time className="mx-unit">
              {new Date(Number(info.dateShortInterest) * 1000)
                .toISOString()
                .slice(0, 10)}
            </time>
          ) : undefined
        }
      >
        <Facts
          rows={[
            [
              t("空头占流通股", "Short % of float"),
              percent(info.shortPercentOfFloat),
            ],
            [t("回补天数", "Days to cover"), number(info.shortRatio, 2)],
            [t("空头股数", "Shares short"), compact(info.sharesShort)],
            [
              t("上期空头股数", "Prior shares short"),
              compact(info.sharesShortPriorMonth),
            ],
          ]}
        />
      </Panel>
    </div>
  );
}

export function DividendHistory({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const rows = objects(object(data.researchEvidence).dividends).sort((a, b) =>
    str(b.date).localeCompare(str(a.date)),
  );
  const [all, setAll] = useState(false);
  const [mode, setMode] = useState("annual");
  if (!rows.length) return null;
  const code = str(rows[0]?.currency) || data.context?.quote.currency || "";
  const evidence = object(data.researchEvidence);
  const coverage = object(evidence.dividendCoverage);
  const summary = dividendSummary(
    rows.filter((r) => !r.currency || r.currency === code),
    str(evidence.asOf),
    typeof coverage.hasEarlierRecords === "boolean"
      ? coverage.hasEarlierRecords
      : undefined,
  );
  if (!summary) return null;
  const series = mode === "ttm" ? summary.trailing : summary.annual;
  return (
    <Panel
      title={t("每股分红", "Dividends per share")}
      action={
        <span className="mx-unit">
          {code} · {summary.asOf}
        </span>
      }
      help={t(
        "按除息日汇总行情源提供的每股分红，不重复应用拆股因子。年度趋势只比较完整年度；今年累计单独与去年同日比较。TTM 为向前十二个月。历史起点不明时，不把首个部分年度当成完整年度。",
        "Sums provider-adjusted dividends by ex-date, without applying split factors twice. Annual trends contain complete years; YTD compares the same dates. TTM covers the preceding twelve months. A truncated first year is excluded.",
      )}
    >
      <div className="mx-dividend-summary mx-metric-grid">
        <Metric label={`${summary.year} YTD`} value={number(summary.ytd, 2)} />
        <Metric
          label={t("去年同期", "Prior-year YTD")}
          value={number(summary.priorYtd, 2)}
        />
        <Metric
          label={t("同期变化", "YTD change")}
          value={percent(summary.ytdChange, true)}
        />
        <Metric label="TTM" value={number(summary.ttm, 2)} />
      </div>
      <Segments
        label={t("分红期间", "Dividend periods")}
        value={mode}
        onChange={setMode}
        options={[
          { value: "annual", label: t("完整年度", "Complete years") },
          { value: "ttm", label: t("滚动十二个月", "Trailing 12 months") },
        ]}
      />
      {series.length ? (
        <Plot
          label={
            mode === "ttm"
              ? t("滚动十二个月分红", "Trailing twelve-month dividends")
              : t("完整年度每股分红", "Complete-year dividends per share")
          }
          height={245}
          option={(c) => ({
            xAxis: {
              type: "category",
              data: series.map((r) => r.date),
              boundaryGap: false,
              axisLabel: {
                color: c.axis,
                formatter: (date: string) =>
                  mode === "ttm" ? date.slice(0, 7) : date,
              },
            },
            yAxis: {
              type: "value",
              min: 0,
              axisLabel: { color: c.axis },
              splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
            },
            tooltip: { valueFormatter: (v) => number(v, 2) },
            series: [
              {
                type: "line",
                name: code,
                data: series.map((r) => r.value),
                smooth: false,
                connectNulls: false,
                showSymbol: mode === "annual" || series.length === 1,
                symbolSize: 7,
                lineStyle: { color: c.brand, width: 2 },
                itemStyle: { color: c.brand },
              },
            ],
          })}
        />
      ) : (
        <Empty title={t("尚无完整年度记录", "No complete-year records yet")} />
      )}
      <details className="mx-chart-data">
        <summary onClick={() => setAll(true)}>
          {t("除息记录", "Ex-dividend records")}
        </summary>
        {all && (
          <div className="mx-table-scroll">
            <table className="mx-financial-table">
              <thead>
                <tr>
                  <th>{t("除息日", "Ex-dividend date")}</th>
                  <th>{t("每股金额", "Amount per share")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <th>{str(r.date)}</th>
                    <td>
                      {number(r.amount, 4)} {code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </Panel>
  );
}

export function ResearchDocuments({
  data,
  news = false,
}: {
  data: ResearchLensSnapshot;
  news?: boolean;
}) {
  const t = useCopy(),
    { params, update } = useRouteState("push");
  const [limit, setLimit] = useState(20);
  const form = params.get("documentType") ?? "all",
    source = params.get("newsSource") ?? "all";
  const search = params.get("documentQuery") ?? "";
  const eventDate = params.get("documentDate");
  const raw = objects(
    object(data.researchEvidence)[news ? "news" : "filings"],
  ).filter((r) => safeUrl(str(r.url)));
  const rows = raw.filter(
    (r) =>
      (news || form === "all" || str(r.form) === form) &&
      (!news || source === "all" || str(r.source) === source) &&
      (!eventDate ||
        Math.abs(
          Date.parse(str(r.publishedAt ?? r.date)) - Date.parse(eventDate),
        ) <=
          3 * 86400000) &&
      [
        data.ticker,
        r.title,
        r.form,
        r.date,
        r.accession,
        r.publishedAt,
        r.periodEnd,
        r.fiscalPeriod,
        r.fiscalYear && `FY${r.fiscalYear}`,
      ]
        .map(str)
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Panel
      title={
        news
          ? t("相关新闻", "Related news")
          : t("公司披露", "Company disclosures")
      }
      action={
        <Group gap="xs">
          <TextInput
            aria-label={t("查找研究材料", "Find research materials")}
            placeholder={t(
              "标题、财期或文件编号",
              "Title, period or accession",
            )}
            value={search}
            onChange={(e) => {
              update({ documentQuery: e.target.value || null });
              setLimit(20);
            }}
          />
          <Select
            aria-label={
              news ? t("新闻来源", "News source") : t("披露类型", "Filing type")
            }
            value={news ? source : form}
            onChange={(v) => {
              update(news ? { newsSource: v } : { documentType: v });
              setLimit(20);
            }}
            data={[
              {
                value: "all",
                label: news
                  ? t("全部来源", "All sources")
                  : t("全部文件", "All filings"),
              },
              ...[...new Set(raw.map((r) => str(r[news ? "source" : "form"])))]
                .filter(Boolean)
                .map((f) => ({ value: f, label: f })),
            ]}
          />
        </Group>
      }
    >
      {eventDate && (
        <button
          className="mx-text-link"
          onClick={() => update({ documentDate: null })}
        >
          {eventDate} ± 3 {t("天 · 清除日期筛选", "days · Clear date filter")}
        </button>
      )}
      <span role="status" className="mx-result-count">
        {rows.length} {t("条记录", "records")}
      </span>
      {!rows.length ? (
        <Empty title={t("没有符合条件的记录", "No matching records")} />
      ) : (
        <div className="mx-document-feed">
          {rows.slice(0, limit).map((row, i) => (
            <article key={str(row.id) || i}>
              <time>{str(row.publishedAt ?? row.date).slice(0, 10)}</time>
              <div>
                <a
                  href={safeUrl(str(row.url))}
                  target="_blank"
                  rel="noreferrer"
                >
                  {news
                    ? str(row.title)
                    : str(row.form) + " · " + str(row.title)}{" "}
                  ↗
                </a>
                {news ? (
                  <span>{str(row.source)}</span>
                ) : (
                  <>
                    {Boolean(row.periodEnd) && (
                      <span>
                        {str(row.fiscalPeriod)}{" "}
                        {row.fiscalYear ? `FY${row.fiscalYear}` : ""} ·{" "}
                        {str(row.periodEnd)}
                      </span>
                    )}
                    {Boolean(row.accession) && (
                      <small>{str(row.accession)}</small>
                    )}
                    <div className="mx-document-links">
                      {safeUrl(str(row.amendsUrl)) && (
                        <a
                          href={safeUrl(str(row.amendsUrl))}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("修订前原件", "Original filing")} ↗
                        </a>
                      )}
                      {objects(row.amendments).map((amendment) =>
                        safeUrl(str(amendment.url)) ? (
                          <a
                            key={str(amendment.id)}
                            href={safeUrl(str(amendment.url))}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("修订版", "Amendment")} · {str(amendment.date)}{" "}
                            ↗
                          </a>
                        ) : null,
                      )}
                      {Object.entries(object(row.documents))
                        .filter(([, url]) => safeUrl(str(url)))
                        .map(([key, url]) => (
                          <a
                            key={key}
                            href={safeUrl(str(url))}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {key} ↗
                          </a>
                        ))}
                    </div>
                  </>
                )}
                <button
                  className="mx-text-link"
                  onClick={() =>
                    update({
                      view: "technical",
                      technicalView: null,
                      chart: "full",
                      eventDate: str(row.publishedAt ?? row.date).slice(0, 10),
                      priceRange: "ALL",
                      interval: "1d",
                    })
                  }
                >
                  {t("查看当时走势", "View price at this date")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {rows.length > limit && (
        <button className="mx-text-link" onClick={() => setLimit(limit + 20)}>
          {t("更多记录", "More records")}
        </button>
      )}
    </Panel>
  );
}
