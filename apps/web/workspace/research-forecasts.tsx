"use client";

import { useState } from "react";
import type { ResearchLensSnapshot } from "@/lib/types";
import {
  compact,
  currency,
  number,
  numeric,
  object,
  objects,
  percent,
  str,
  tone,
} from "./data";
import { estimateGroups } from "./research-display";
import { Empty, Panel, Segments, useCopy } from "./foundation";

export function AnalystEstimates({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [period, setPeriod] = useState("quarter");
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
  const label = (value: unknown) =>
    ({
      "0q": t("本季度", "Current quarter"),
      "+1q": t("下季度", "Next quarter"),
      "0y": t("本财年", "Current year"),
      "+1y": t("下财年", "Next year"),
    })[str(value)] ?? str(value);
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
          onChange={setPeriod}
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
          const format = (value: unknown, code: string) =>
            numeric(value) == null
              ? "—"
              : measure.revenue
                ? compact(value)
                : code
                  ? currency(value, code, 2)
                  : number(value, 2);
          return (
            <section key={measure.title}>
              <h3>{measure.title}</h3>
              {rows.length ? (
                <div
                  className="mx-table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={measure.title + t("预期", " estimates")}
                >
                  <table className="mx-table mx-forecast-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("报告期", "Period")}</th>
                        {rows.map((row, i) => (
                          <th scope="col" key={i}>
                            {label(row.period ?? row.index)}
                            <small>
                              {str(row.currency) ||
                                t("币种未提供", "Currency unavailable")}
                            </small>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="mx-forecast-average">
                        <th scope="row">{t("平均预期", "Average")}</th>
                        {rows.map((row, i) => (
                          <td key={i}>{format(row.avg, str(row.currency))}</td>
                        ))}
                      </tr>
                      <tr>
                        <th scope="row">{t("预期区间", "Range")}</th>
                        {rows.map((row, i) => (
                          <td key={i}>
                            {format(row.low, str(row.currency))}
                            <span className="mx-range-separator">—</span>
                            {format(row.high, str(row.currency))}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <th scope="row">{t("去年同期", "Year ago")}</th>
                        {rows.map((row, i) => (
                          <td key={i}>
                            {format(row[measure.prior], str(row.currency))}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <th scope="row">{t("同比增长", "YoY growth")}</th>
                        {rows.map((row, i) => (
                          <td key={i} className={"mx-" + tone(row.growth)}>
                            {percent(row.growth, true, 1)}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <th scope="row">{t("分析师人数", "Analysts")}</th>
                        {rows.map((row, i) => (
                          <td key={i}>{number(row.numberOfAnalysts, 0)}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
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
