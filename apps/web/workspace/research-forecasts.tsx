"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button } from "@mantine/core";
import { compact, currency, number, object, objects, percent, str, tone } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { Empty, Panel, Segments, useCopy } from "./foundation";
import { estimateGroups } from "./research-display";
import { useRouteState } from "./route-state";

export function forecastPeriodLabel(
  analyst: Record<string, unknown>,
  value: unknown,
  t: ReturnType<typeof useCopy>,
) {
  const fiscal = objects(analyst.fiscalPeriods).find((p) => p.period === value);
  const end = str(fiscal?.endDate);
  if (end)
    return (
      (str(value).endsWith("y")
        ? t("财年截至 ", "FY ending ")
        : t("季度截至 ", "Quarter ending ")) + end
    );
  const relative =
    {
      "0q": t("本季度", "Current quarter"),
      "+1q": t("下季度", "Next quarter"),
      "0y": t("本财年", "Current year"),
      "+1y": t("下财年", "Next year"),
    }[str(value)] ?? str(value);
  const asOf = str(analyst.asOf).slice(0, 10);
  return relative + (asOf ? " · " + asOf : "");
}

export function AnalystEstimates({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
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
  const label = (value: unknown) => {
    const fiscal = objects(analyst.fiscalPeriods).find(
      (p) => p.period === value,
    );
    const end = str(fiscal?.endDate);
    if (end)
      return str(value).endsWith("y")
        ? t("财年截至 ", "FY ending ") + end
        : t("季度截至 ", "Quarter ending ") + end;
    const relative =
      {
        "0q": t("本季度", "Current quarter"),
        "+1q": t("下季度", "Next quarter"),
        "0y": t("本财年", "Current year"),
        "+1y": t("下财年", "Next year"),
      }[str(value)] ?? str(value);
    const asOf = str(analyst.asOf).slice(0, 10);
    return relative + (asOf ? " · " + asOf : "");
  };
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
          onChange={(v) => update({ estimateFrequency: v })}
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
                      {measure.revenue && period === "year" && (
                        <tr>
                          <th scope="row">
                            {t("估值参考", "Valuation reference")}
                          </th>
                          {rows.map((row, i) => (
                            <td key={i}>
                              {numeric(row.growth) != null ? (
                                <Button
                                  size="compact-xs"
                                  variant="subtle"
                                  onClick={() =>
                                    update({
                                      view: "valuation",
                                      estimateRef: str(row.period ?? row.index),
                                    })
                                  }
                                >
                                  {t("带入模型参考", "Use as model reference")}
                                </Button>
                              ) : (
                                "—"
                              )}
                            </td>
                          ))}
                        </tr>
                      )}
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
