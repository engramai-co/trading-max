"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Select } from "@mantine/core";
import { quoteUnit, quoteValue } from "./financial-values";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { compact, number, object, objects, percent, str } from "@/workspace/data";
import { numeric } from "@/lib/numeric";
import { Facts, Panel, useCopy } from "./foundation";
import type { Preview } from "./research-facts";
import { evidenceGroups, metricNames } from "./research-facts";

const keys = ["bear", "base", "bull"] as const;

/** Growth × cost-of-equity grid around the base scenario. */
export function ValuationSensitivity({ result }: { result: Preview }) {
  const t = useCopy();
  const residual = result.basis.family === "residual-income";
  return (
      <Panel
        title={residual ? t("ROE × 股权成本","ROE × cost of equity") : t("增长 × 折现率", "Growth × cost of equity")}
        action={
          <span className="mx-unit">
            {result.horizon}
            {t(" 年", " years")} · {quoteUnit(result.basis.currency).currency}
          </span>
        }
      >
        <div
          className="mx-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t(
            "二维敏感性矩阵",
            "Two-dimensional sensitivity matrix",
          )}
        >
          <table className="mx-sensitivity-matrix">
            <thead>
              <tr>
                <th>{residual ? t("折现率 / ROE","Discount / ROE") : t("折现率 / 增长", "Discount / growth")}</th>
                {result.sensitivity.slice(0, 5).map((cell, i) => (
                  <th key={i}>{percent(cell.growth)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4].map((row) => (
                <tr key={row}>
                  <th>{percent(result.sensitivity[row * 5].discountRate)}</th>
                  {result.sensitivity
                    .slice(row * 5, row * 5 + 5)
                    .map((cell, col) => (
                      <td
                        key={col}
                        data-base={(row === 2 && col === 2) || undefined}
                        data-direction={
                          cell.upside >= 0 ? "positive" : "negative"
                        }
                        data-tone={cell.upside >= 0 ? "up" : "down"}
                      >
                        <strong>{quoteValue(cell.value, result.basis.currency, { style: "figure" })}</strong>
                        <span>{percent(cell.upside, true, 1)}</span>
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
  );
}

/** Year-by-year projection of one scenario, with its inputs and sources. */
export function ValuationWorksheet({
  result,
  projection,
  worksheet,
  onWorksheet,
  scenarioNames,
}: {
  result: Preview;
  projection: Preview["scenarios"][string];
  worksheet: string;
  onWorksheet: (scenario: string) => void;
  scenarioNames: Record<string, string>;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const residual = result.basis.family === "residual-income";
  const earnings = result.basis.family === "net-income";
  const financed = projection.years.some(year => year.financing != null);
  return (
      <Panel
        title={t("年度计算底稿", "Annual projection")}
        action={
          <Select
            aria-label={t("底稿情景", "Worksheet scenario")}
            value={worksheet}
            onChange={(v) => onWorksheet(v ?? "base")}
            data={keys.map((k) => ({ value: k, label: scenarioNames[k] }))}
          />
        }
      >
        <div
          className="mx-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t("现金流预测明细", "Cash-flow projection details")}
        >
          <table className="mx-financial-table">
            <thead>
              <tr>
                <th>{t("年份", "Year")}</th>
                {residual ? (
                  <>
                    <th>ROE</th>
                    <th>{t("期末每股净资产", "Closing book / share")}</th>
                    <th>{t("每股盈利", "Earnings / share")}</th>
                    <th>{t("每股剩余收益", "Residual income / share")}</th>
                  </>
                ) : (
                  <>
                    <th>{t("增长", "Growth")}</th>
                    <th>{t("营收", "Revenue")}</th>
                    <th>{earnings ? t("净利率", "Net margin") : t("现金流率", "FCF margin")}</th>
                    <th>{earnings ? t("净利润", "Net income") : t("现金流", "Cash flow")}</th>
                    {financed && <th>{t("股权融资", "Equity issued")}</th>}
                    <th>{t("股数", "Shares")}</th>
                    <th>{earnings ? t("每股盈利", "Earnings / share") : t("每股净流量", "Net flow / share")}</th>
                  </>
                )}
                <th>{t("折现后每股值", "PV / share")}</th>
              </tr>
            </thead>
            <tbody>
              {projection.years.map((y) => (
                <tr key={y.year}>
                  <th>{y.year}</th>
                  {residual ? (
                    <>
                      <td>{percent(y.roe)}</td>
                      <td>{quoteValue(y.closingBook, result.basis.currency)}</td>
                      <td>{quoteValue(y.earningsPerShare, result.basis.currency)}</td>
                    </>
                  ) : (
                    <>
                      <td>{percent(y.growth)}</td>
                      <td>{quoteValue(y.revenue, result.basis.currency, { style: "compact", locale })}</td>
                      <td>{percent(y.fcfMargin)}</td>
                      <td>{quoteValue(y.freeCashflow, result.basis.currency, { style: "compact", locale })}</td>
                      {financed && <td>{quoteValue(y.financing ?? 0, result.basis.currency, { style: "compact", locale })}</td>}
                      <td>{compact(y.shares, locale)}</td>
                    </>
                  )}
                  <td>{quoteValue(y.cashflowPerShare, result.basis.currency)}</td>
                  <td>{quoteValue(y.presentValue, result.basis.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={residual ? 4 : financed ? 7 : 6}>
                  {residual
                    ? t("期初净资产 + 剩余收益现值", "Opening book + PV of residual earnings")
                    : earnings
                      ? t("净利润现值", "Present value of earnings")
                      : t("预测现金流现值", "Projected cash-flow present value")}
                </th>
                <td colSpan={2}>{quoteValue(projection.operatingValue, result.basis.currency)}</td>
              </tr>
              <tr>
                <th colSpan={residual ? 4 : financed ? 7 : 6}>
                  {residual ? t("期末溢价现值", "Discounted terminal premium") :
                    <>{t("终值现值", "Terminal present value")} · {percent(projection.terminalContribution)}</>}
                </th>
                <td colSpan={2}>{quoteValue(residual ? projection.terminalPremiumPresentValue : projection.terminalPresentValue, result.basis.currency)}</td>
              </tr>
              <tr>
                <th colSpan={residual ? 4 : financed ? 7 : 6}>{t("每股价值", "Value per share")}</th>
                <td colSpan={2}>{quoteValue(projection.value, result.basis.currency)}</td>
              </tr>
              {residual && <tr>
                <th colSpan={4}>{t("期末卖出价现值占每股价值", "Discounted exit price / value")}</th>
                <td colSpan={2}>{percent(projection.terminalContribution)}</td>
              </tr>}
              {projection.equityFloorAdjustment > 0 && (
                <tr>
                  <th colSpan={residual ? 4 : financed ? 7 : 6}>
                    {t("股权零下限调整", "Equity zero-floor adjustment")}
                  </th>
                  <td colSpan={2}>{quoteValue(projection.equityFloorAdjustment, result.basis.currency)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        <details className="mx-chart-data">
          <summary>{t("输入与来源", "Inputs & sources")}</summary>
          <dl className="mx-evidence-inputs">
            {residual ? <>
              <dt>{t("普通股净利润", "Common earnings")}</dt>
              <dd>{quoteValue(result.basis.commonEarnings, result.basis.currency, { digits: 0 })}</dd>
              <dt>{t("每股净资产", "Book value per share")}</dt>
              <dd>{quoteValue(result.basis.bookPerShare, result.basis.currency)}</dd>
            </> : <>
            <dt>{t("起始营收", "Starting revenue")}</dt>
            <dd>{quoteValue(result.basis.revenue, result.basis.currency, { digits: 0 })}</dd>
            <dt>
              {earnings
                ? t("起始净利率", "Starting net margin")
                : t("起始现金流率", "Starting FCF margin")}
            </dt>
            <dd>{percent(result.basis.startMargin, false, 2)}</dd>
            </>}
            <dt>{t("总股数", "Shares outstanding")}</dt>
            <dd>{number(result.basis.shares, 0)}</dd>
          </dl>
          <ul className="mx-source-list">
            {(result.references ?? []).map((reference, i) => (
              <li key={`reference-${i}`}>
                <strong>
                  {scenarioNames[reference.scenario]} ·{" "}
                  {reference.source === "historical-revenue-cagr"
                    ? t("历史营收 CAGR", "Historical revenue CAGR")
                    : t("营收共识参考", "Revenue consensus reference")}
                </strong>
                <span>
                  {reference.period} · {percent(reference.referenceValue ?? reference.value, false, 2)}
                  {!!reference.adjustment &&
                    ` · ${t("情景调整", "Scenario adjustment")} ${number(reference.adjustment * 100, 2)} pp`}
                </span>
                {(reference.evidence ?? []).map((e, j) =>
                  e.url ? (
                    <a
                      key={j}
                      href={e.url}
                      rel="noreferrer"
                      target="_blank"
                      aria-label={`${t("营收共识参考", "Revenue consensus reference")} · ${e.publishedAt ?? t("原始披露", "original filing")}`}
                    >
                      {e.publishedAt
                        ? formatCalendarDate(e.publishedAt, locale)
                        : t("原始披露", "Original filing")}{" "}
                      ↗
                    </a>
                  ) : null,
                )}
              </li>
            ))}
            {evidenceGroups(result.basis.evidence ?? []).map((g) => (
              <li key={g.metric}>
                <strong>{metricNames[g.metric] ? t(...metricNames[g.metric]) : g.metric}</strong>
                {g.source && <span>{g.source}</span>}
                {g.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    rel="noreferrer"
                    target="_blank"
                    aria-label={`${metricNames[g.metric] ? t(...metricNames[g.metric]) : g.metric} · ${l.date ?? t("原始披露", "original filing")}`}
                  >
                    {l.date ? formatCalendarDate(l.date, locale) : t("原始披露", "Original filing")} ↗
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </details>
      </Panel>
  );
}

export function GrowthContext({
  data,
  analyst,
}: {
  data: ResearchLensSnapshot;
  analyst: Record<string, unknown>;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const facts = data.financialFacts;
  const annual = (facts?.periods ?? [])
    .filter((p) => p.kind === "annual")
    .map((p) => ({
      date: p.providerEnd,
      value: facts?.observations.find(
        (o) => o.periodId === p.id && o.metric === "revenue",
      )?.value,
    }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const filed = objects(object(data.researchEvidence).annualRevenue)
    .filter((o) => o.currency === facts?.currency)
    .map((o) => ({ date: str(o.periodEnd), value: numeric(o.value) }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const cagr = (years: number) => {
    for (const series of [annual, filed]) {
      const last = series.at(-1);
      if (!last?.value || last.value <= 0) continue;
      const first = series.find(
        (o) =>
          o.value != null &&
          o.value > 0 &&
          Math.abs(
            (Date.parse(last.date) - Date.parse(o.date)) / 86400000 / 365.25 -
              years,
          ) < 0.08,
      );
      if (first?.value)
        return percent(
          (last.value / first.value) **
            ((365.25 * 86400000) /
              (Date.parse(last.date) - Date.parse(first.date))) -
            1,
          true,
          2,
        );
    }
    return "—";
  };
  const quarter = facts?.periods
    .filter((p) => p.kind === "quarterly")
    .toSorted((a, b) => b.providerEnd.localeCompare(a.providerEnd))[0];
  const yoy = facts?.observations.find(
    (o) => o.periodId === quarter?.id && o.metric === "revenueGrowth",
  )?.value;
  const next = objects(analyst.revenueEstimate).find(
    (r) => str(r.period ?? r.index) === "+1y",
  );
  // Name the fiscal year the consensus covers instead of appending its end date.
  const nextYear = str(next?.endDate).slice(0, 4);
  return (
    <Panel
      className="mx-growth-context"
      title={t("营收增长参考", "Revenue-growth reference")}
      help={t(
        "历史 CAGR 按所示年度收入跨度复算；最新季度同比与下一财年共识各用自己的期间。它们是参考，修改模型仍由你决定。",
        "Historical CAGR uses the available annual-revenue span. Latest-quarter YoY and next-fiscal-year consensus retain their own periods. These references do not overwrite your model inputs.",
      )}
    >
      <Facts
        rows={[
          [t("历史 3 年 CAGR", "Historical 3Y CAGR"), cagr(3)],
          [t("历史 5 年 CAGR", "Historical 5Y CAGR"), cagr(5)],
          [
            quarter
              ? `${quarter.label} ${t("同比", "YoY")}`
              : t("最新季度同比", "Latest-quarter YoY"),
            percent(yoy, true, 2),
          ],
          [
            nextYear
              ? locale === "zh" ? `${nextYear} 财年营收共识` : `FY${nextYear} revenue consensus`
              : t("下一财年营收共识", "Next fiscal-year revenue consensus"),
            percent(next?.growth, true, 2),
          ],
        ]}
      />
    </Panel>
  );
}
