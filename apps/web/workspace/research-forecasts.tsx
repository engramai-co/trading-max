"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import type { ResearchLensSnapshot } from "@/lib/types";
import type { ReactNode } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatDate } from "@/ui/formatters";
import { compact, currency, number, object, objects, percent, str, tone } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { Empty, Panel, Segments, useCopy } from "./foundation";
import { estimateGroups, shortForecastPeriod } from "./research-display";
import { useRouteState } from "./route-state";

/** A compact amount with its currency's symbol, as the EPS cells carry theirs: US$1564亿, US$156.4bn. */
function compactMoney(value: unknown, code: string, locale: Locale) {
  const n = numeric(value);
  if (n == null) return "—";
  try {
    const symbol = new Intl.NumberFormat("en-GB", { style: "currency", currency: code })
      .formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
    return (n < 0 ? "-" : "") + symbol + compact(Math.abs(n), locale);
  } catch {
    return compact(n, locale) + " " + code;
  }
}

/** Fiscal periods always carry their year, so neighbouring columns read alike. */
export function forecastPeriodLabel(
  analyst: Record<string, unknown>,
  value: unknown,
  t: ReturnType<typeof useCopy>,
) {
  const locale = t("zh", "en") as "zh" | "en";
  const fiscal = objects(analyst.fiscalPeriods).find((p) => p.period === value);
  const end = str(fiscal?.endDate);
  if (end)
    return (
      (str(value).endsWith("y")
        ? t("财年截至 ", "FY ending ")
        : t("季度截至 ", "Quarter ending ")) +
      formatDate(end.slice(0, 10), locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    );
  const relative =
    {
      "0q": t("本季度", "Current quarter"),
      "+1q": t("下季度", "Next quarter"),
      "0y": t("本财年", "Current year"),
      "+1y": t("下财年", "Next year"),
    }[str(value)] ?? str(value);
  const asOf = str(analyst.asOf).slice(0, 10);
  return relative + (asOf ? " · " + formatCalendarDate(asOf, locale) : "");
}

export function AnalystEstimates({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const { locale } = useLocale();
  const { params, update } = useRouteState("push");
  const period =
    params.get("estimateFrequency") === "year" ? "year" : "quarter";
  const analyst = object(data.analyst);
  const measures = [
    {
      title: t("每股收益", "Earnings per share"),
      rows: objects(analyst.earningsEstimate),
      revenue: false,
      prior: "yearAgoEps",
    },
    {
      title: t("营收", "Revenue"),
      rows: objects(analyst.revenueEstimate),
      revenue: true,
      prior: "yearAgoRevenue",
    },
  ];
  const label = (value: unknown) => forecastPeriodLabel(analyst, value, t);
  return (
    <Panel
      title={t("盈利与营收预期", "Earnings & revenue estimates")}
      help={t(
        "季度与财年分别比较，范围为分析师最低和最高估计。同比使用数据源提供的同口径增长率；预期会随机构修订而变化。",
        "Quarterly and fiscal-year estimates are compared separately. Ranges show the lowest and highest analyst estimates. Growth uses the provider's matching year-over-year comparison; estimates change as analysts revise them.",
      )}
      action={
        <Segments
          label={t("预期报告周期", "Estimate reporting period")}
          value={period}
          onChange={(v) => update({ estimateFrequency: v }, { focusResearchSection: false })}
          options={[
            { value: "quarter", label: t("季度", "Quarterly") },
            { value: "year", label: t("年度", "Annual") },
          ]}
        />
      }
    >
      <div className="mx-grid mx-forecast-grid">
        {measures.map((measure) => {
          const rows =
            estimateGroups(measure.rows).find((group) => group.key === period)
              ?.rows ?? [];
          // Every amount carries its currency; a row without one says so in its heading.
          const format = (value: unknown, code: string) =>
            numeric(value) == null
              ? "—"
              : !code
                ? measure.revenue ? compact(value, locale) : number(value, 2)
                : measure.revenue
                  ? compactMoney(value, code, locale)
                  : currency(value, code, 2);
          type Row = (typeof rows)[number];
          const fields: { label: string; read: (r: Row, compact?: boolean) => ReactNode }[] = [
            { label: t("平均预期", "Average"), read: (r: Row) => format(r.avg, str(r.currency)) },
            { label: t("预期区间", "Range"), read: (r: Row) => <>{format(r.low, str(r.currency))}<span className="mx-range-separator">—</span>{format(r.high, str(r.currency))}</> },
            { label: t("去年同期", "Year ago"), read: (r: Row) => format(r[measure.prior], str(r.currency)) },
            { label: t("同比增长", "YoY growth"), read: (r: Row) => <span className={"mx-" + tone(r.growth)}>{percent(r.growth, true, 1)}</span> },
            { label: t("分析师人数", "Analysts"), read: (r: Row) => number(r.numberOfAnalysts, 0) },
            ...(measure.revenue && period === "year" ? [{ label: t("估值参考", "Valuation reference"), read: (r: Row, compact = false) =>
              numeric(r.growth) == null ? "—" : <Button size={compact ? "default" : "table"} variant="ghost"
                onClick={() => update({ view: "valuation", valuationView: "scenario", estimateRef: str(r.period ?? r.index) })}>
                {t("带入模型参考", "Use as model reference")}</Button> }] : []),
          ];
          const unit = (row: Row) => !str(row.currency) && <small>{t("币种未提供", "Currency unavailable")}</small>;
          return (
            <section key={measure.title}>
              <h3>{measure.title}</h3>
              {rows.length ? <div className="tm-table-variants">
                <Table containerProps={{ className: "mx-table-wrap tm-table-wide" }} label={measure.title + t("预期", " estimates")} className="mx-table mx-forecast-table">
                  <TableHeader><TableRow><TableHead scope="col">{t("报告期", "Period")}</TableHead>
                    {rows.map((row, i) => <TableHead scope="col" key={i}>{label(row.period ?? row.index)}{unit(row)}</TableHead>)}
                  </TableRow></TableHeader>
                  <TableBody>{fields.map((field, index) => <TableRow key={field.label} className={index === 0 ? "mx-forecast-average" : undefined}>
                    <TableHead scope="row">{field.label}</TableHead>{rows.map((row, i) => <TableCell key={i}>{field.read(row, false)}</TableCell>)}
                  </TableRow>)}</TableBody>
                </Table>
                <div className="mx-compact-records tm-table-compact">
                  {rows.map((row, i) => <section key={i}>
                    <h4><abbr title={label(row.period ?? row.index)}>{shortForecastPeriod(analyst, row.period ?? row.index) ?? label(row.period ?? row.index)}</abbr> {unit(row)}</h4>
                    <dl>{fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.read(row, true)}</dd></div>)}</dl>
                  </section>)}
                </div>
              </div> : (
                <Empty
                  title={t("这个周期暂无预期", "No estimates for this period")}
                />
              )}
              {estimateGroups(measure.rows)
                .find((group) => group.key === "other")
                ?.rows.map((row, i) => (
                  <p key={i}>
                    {label(row.period ?? row.index)} ·{" "}
                    {format(row.avg, str(row.currency))}
                  </p>
                ))}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}
