"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import { Button, Group, NumberInput, Select } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Plot } from "./charts";
import {
  api,
  compact,
  currency,
  jsonRequest,
  number,
  numeric,
  object,
  objects,
  percent,
  str,
  tone,
} from "./data";
import {
  Empty,
  Facts,
  Metric,
  Panel,
  Pending,
  QueryError,
  Segments,
  useCopy,
} from "./foundation";
import type { Preview, ScenarioInput } from "./research-facts";
import {
  FilingMultiples,
  ModelAlternatives,
} from "./research-valuation-context";
import { researchLensQuery } from "./research-queries";
import { useRouteState } from "./route-state";

const keys = ["bear", "base", "bull"] as const;
type Scenarios = Record<string, ScenarioInput>;

export function ValuationWorkbench({ data, revision }: { data: ResearchLensSnapshot; revision?: string | null }) {
  const t = useCopy();
  const financial =
    data.context?.capabilities.some(
      (c) => c.reason === "financial-company-requires-equity-model",
    ) ?? false;
  const query = useQuery({
    queryKey: [
      "valuation-workbench",
      data.ticker,
      data.context?.quote.id,
      data.financialFacts?.version,
    ],
    queryFn: ({ signal }) =>
      api<Preview>(
        `/research/${encodeURIComponent(data.ticker)}/valuation-preview`,
        { signal },
      ),
    retry: false,
    enabled: !financial,
  });
  if (financial)
    return (
      <>
        <ModelAlternatives data={data} financial />
        <FilingMultiples data={data} />
      </>
    );
  if (query.isPending) return <Pending />;
  if (query.isError)
    return (
      <>
        <ModelAlternatives data={data} financial={false} />
        <Panel title={t("估值模型", "Valuation model")}>
          <Empty
            title={t(
              "当前数据不足以建立现金流模型",
              "Cash-flow model inputs are incomplete",
            )}
          />
          <QueryError retry={query.refetch} />
        </Panel>
        <FilingMultiples data={data} />
      </>
    );
  return (
    <>
      <ModelEditor key={query.data.id} initial={query.data} data={data} revision={revision} />
      <FilingMultiples data={data} />
    </>
  );
}

function ModelEditor({
  initial,
  data,
  revision,
}: {
  initial: Preview;
  data: ResearchLensSnapshot;
  revision?: string | null;
}) {
  const t = useCopy();
  const client = useQueryClient();
  const { params, update } = useRouteState("push");
  const horizon = params.has("horizon")
    ? params.get("horizon") === "10"
      ? 10
      : 5
    : initial.horizon;
  const [inputs, setInputs] = useState<Scenarios>(() =>
    Object.fromEntries(keys.map((k) => [k, initial.scenarios[k].inputs])),
  );
  const [selected, setSelected] = useState<string>("base");
  const [worksheet, setWorksheet] = useState<string>("base");
  const [references, setReferences] = useState<
    NonNullable<Preview["references"]>
  >(initial.references ?? []);
  const reference = useQuery(researchLensQuery(initial.basis.ticker, "analyst", revision ?? data.runId));
  const analyst = object(reference.data?.analyst);
  const estimate = objects(analyst.revenueEstimate).find(
    (r) => str(r.period ?? r.index) === params.get("estimateRef"),
  );
  const estimateGrowth = numeric(estimate?.growth);
  const [debounced] = useDebouncedValue(
    {
      scenarios: inputs,
      horizon,
      dataVersion: initial.basis.dataVersion,
      references,
    },
    250,
  );
  const request = JSON.stringify(debounced);
  const query = useQuery({
    queryKey: ["valuation-preview", initial.id, request],
    queryFn: ({ signal }) =>
      api<Preview>(
        `/research/${encodeURIComponent(initial.basis.ticker)}/valuation-preview`,
        { ...jsonRequest("POST", debounced), signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  const result = query.data ?? initial;
  const busy =
    query.isFetching ||
    JSON.stringify(debounced.scenarios) !== JSON.stringify(inputs) ||
    debounced.horizon !== horizon;
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(
        `/research/${encodeURIComponent(initial.basis.ticker)}/models`,
        jsonRequest("POST", {
          scenarios: inputs,
          horizon,
          dataVersion: initial.basis.dataVersion,
          references,
        }),
      ),
    onSuccess: async () => {
      setSaved(true);
      await client.invalidateQueries({
        queryKey: ["workspace-valuation-assumptions"],
      });
      await client.invalidateQueries({
        queryKey: ["research-journal", initial.basis.ticker],
      });
    },
  });
  const scenarioNames: Record<string, string> = {
    bear: t("保守", "Bear"),
    base: t("基准", "Base"),
    bull: t("乐观", "Bull"),
  };
  const fields: {
    key: keyof ScenarioInput;
    label: string;
    min: number;
    max: number;
    scale: number;
    suffix: string;
  }[] = [
    {
      key: "revenueCagr",
      label: t("前五年营收增长", "Revenue growth · years 1–5"),
      min: -80,
      max: 200,
      scale: 100,
      suffix: "%",
    },
    {
      key: "targetFcfMargin",
      label: t("目标现金流率", "Target FCF margin"),
      min: -100,
      max: 100,
      scale: 100,
      suffix: "%",
    },
    {
      key: "discountRate",
      label: t("股权资本成本", "Cost of equity"),
      min: 1,
      max: 60,
      scale: 100,
      suffix: "%",
    },
    {
      key: "exitFcfMultiple",
      label: t("终值现金流倍数", "Terminal FCF multiple"),
      min: 0,
      max: 100,
      scale: 1,
      suffix: "×",
    },
    {
      key: "shareCagr",
      label: t("每年股数变化", "Annual share-count change"),
      min: -30,
      max: 100,
      scale: 100,
      suffix: "%",
    },
  ];
  const base = result.scenarios.base;
  const projection = result.scenarios[worksheet] ?? base;
  return (
    <>
      <div className="mx-model-workbench" aria-busy={busy}>
        <Panel
          title={t("模型假设", "Model assumptions")}
          className="mx-model-inputs"
          help={t(
            "现金流来自四季报表的经营现金流减资本开支，作为股权现金流代理，与股权资本成本配对。十年模型从第六年逐渐收敛至 3% 增长。",
            "Cash flow is reported operating cash flow less capital expenditure, used as an equity cash-flow proxy with cost of equity. In the ten-year model, growth fades toward 3% from year six.",
          )}
        >
          <Segments
            label={t("编辑情景", "Edit scenario")}
            value={selected}
            onChange={setSelected}
            options={keys.map((key) => ({
              value: key,
              label: scenarioNames[key],
            }))}
          />
          {params.get("estimateRef") && (
            <div className="mx-model-reference">
              <strong>{t("营收增长参考", "Revenue-growth reference")}</strong>
              <p>
                {str(estimate?.endDate || params.get("estimateRef"))} ·{" "}
                {percent(estimateGrowth, true)}
              </p>
              <Button
                variant="light"
                size="xs"
                disabled={
                  estimateGrowth == null ||
                  estimateGrowth < -0.8 ||
                  estimateGrowth > 2
                }
                onClick={() => {
                  if (estimateGrowth == null) return;
                  setInputs((v) => ({
                    ...v,
                    [selected]: { ...v[selected], revenueCagr: estimateGrowth },
                  }));
                  setReferences((v) => [
                    ...v.filter((r) => r.scenario !== selected),
                    {
                      metric: "revenueGrowth",
                      scenario: selected as "bear" | "base" | "bull",
                      period: str(
                        estimate?.endDate || params.get("estimateRef"),
                      ),
                      asOf: str(estimate?.asOf || analyst.asOf),
                      value: estimateGrowth,
                      source: "yahoo-finance-consensus",
                      adjustment: 0,
                    },
                  ]);
                  setSaved(false);
                  update({ estimateRef: null });
                }}
              >
                {t(
                  "设为当前情景的前五年增长",
                  "Apply to years 1–5 of this scenario",
                )}
              </Button>
            </div>
          )}
          <div className="mx-model-fields">
            {fields.map((field) => (
              <NumberInput
                key={selected + field.key}
                label={field.label}
                value={Number(
                  (inputs[selected][field.key] * field.scale).toFixed(3),
                )}
                onChange={(v) => {
                  if (
                    typeof v === "number" &&
                    v >= field.min &&
                    v <= field.max
                  ) {
                    setInputs((previous) => ({
                      ...previous,
                      [selected]: {
                        ...previous[selected],
                        [field.key]: v / field.scale,
                      },
                    }));
                    setSaved(false);
                    if (field.key === "revenueCagr")
                      setReferences((v) =>
                        v.filter((r) => r.scenario !== selected),
                      );
                  }
                }}
                min={field.min}
                max={field.max}
                step={field.key === "exitFcfMultiple" ? 1 : 0.5}
                decimalScale={2}
                suffix={field.suffix}
              />
            ))}
          </div>
          <Button
            variant="subtle"
            onClick={() => {
              setInputs(
                Object.fromEntries(
                  keys.map((k) => [k, initial.scenarios[k].inputs]),
                ),
              );
              setSaved(false);
              setReferences(initial.references ?? []);
            }}
          >
            {t("重置假设", "Reset assumptions")}
          </Button>
          <Button
            fullWidth
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={busy || query.isError || saved}
          >
            {saved
              ? t("已保存", "Saved")
              : t("保存模型版本", "Save model version")}
          </Button>
          {save.isError && (
            <p role="alert">
              {t("保存失败，请重试。", "Could not save. Try again.")}
            </p>
          )}
        </Panel>
        <div className="mx-model-output">
          <GrowthContext data={data} analyst={analyst} />
          <Panel
            title={t("情景估值", "Scenario valuation")}
            action={
              <Group gap="xs">
                <Segments
                  label={t("模型周期", "Model horizon")}
                  value={String(horizon)}
                  onChange={(v) => update({ horizon: v })}
                  options={[
                    { value: "5", label: t("5 年", "5 years") },
                    { value: "10", label: t("10 年", "10 years") },
                  ]}
                />
                <span role="status" className="mx-preview-status">
                  {busy ? t("计算中…", "Calculating…") : ""}
                </span>
              </Group>
            }
          >
            <div className="mx-metric-grid mx-metric-grid-three">
              <Metric
                label={t("现价", "Spot")}
                value={currency(result.basis.spot, result.basis.currency, 2)}
              />
              <Metric
                label={t("基准情景", "Base scenario")}
                value={currency(base.value, result.basis.currency, 2)}
              />
              <Metric
                label={t("与现价相比", "Against spot")}
                value={percent(base.upside, true, 2)}
                tone={tone(base.upside)}
              />
            </div>
            {query.isError && (
              <p role="alert">
                {t(
                  "预览计算失败，当前仍为上次结果。",
                  "Preview failed. The previous result is retained.",
                )}
              </p>
            )}
            <Plot
              research
              label={t(
                "三种估值情景与现价",
                "Three valuation scenarios and spot",
              )}
              height={250}
              option={(c) => ({
                grid: { left: 50, right: 100, bottom: 35, top: 22 },
                xAxis: {
                  type: "value",
                  min: 0,
                  axisLabel: { color: c.axis },
                  splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
                },
                yAxis: {
                  type: "category",
                  data: keys.map((k) => scenarioNames[k]),
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: { color: c.text },
                },
                tooltip: {
                  trigger: "item",
                  formatter: (p) => {
                    const point = Array.isArray(p) ? p[0] : p;
                    const item = result.scenarios[keys[point.dataIndex]];
                    return `${scenarioNames[keys[point.dataIndex]]}\n${currency(item.value, result.basis.currency, 2)}\n${percent(item.upside, true, 2)}`;
                  },
                },
                series: [
                  {
                    type: "scatter",
                    symbolSize: 13,
                    itemStyle: { color: c.brand },
                    data: keys.map((k, i) => [result.scenarios[k].value, i]),
                    label: {
                      show: true,
                      position: "right",
                      color: c.text,
                      formatter: (p) =>
                        currency(
                          result.scenarios[keys[p.dataIndex]].value,
                          result.basis.currency,
                          2,
                        ),
                    },
                    markLine: {
                      silent: true,
                      symbol: "none",
                      data: [{ xAxis: result.basis.spot }],
                      lineStyle: { color: c.axis, type: "dashed" },
                      label: { formatter: t("现价", "Spot"), color: c.axis },
                    },
                  },
                ],
              })}
            />
            <div
              className="mx-table-scroll"
              tabIndex={0}
              role="region"
              aria-label={t("情景对照", "Scenario comparison")}
            >
              <table className="mx-financial-table">
                <thead>
                  <tr>
                    <th>{t("情景", "Scenario")}</th>
                    <th>{t("增长", "Growth")}</th>
                    <th>{t("现金流率", "FCF margin")}</th>
                    <th>{t("折现率", "Discount")}</th>
                    <th>{t("价值", "Value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k}>
                      <th>{scenarioNames[k]}</th>
                      <td>{percent(result.scenarios[k].inputs.revenueCagr)}</td>
                      <td>
                        {percent(result.scenarios[k].inputs.targetFcfMargin)}
                      </td>
                      <td>
                        {percent(result.scenarios[k].inputs.discountRate)}
                      </td>
                      <td>
                        {currency(
                          result.scenarios[k].value,
                          result.basis.currency,
                          2,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title={t("价格隐含的增长", "Growth implied by price")}
            help={t(
              "固定基准情景的现金流率、股数、终值倍数和折现率，仅求解让模型价值等于现价的前五年增长率。",
              "Only initial growth changes; the other base assumptions stay fixed while solving for the current price.",
            )}
          >
            <div className="mx-model-growth">
              <Metric
                label={t("模型假设", "Assumed growth")}
                value={percent(base.inputs.revenueCagr)}
              />
              <span aria-hidden>→</span>
              <Metric
                label={t("价格隐含增长", "Price-implied growth")}
                value={
                  result.impliedGrowthBound === "above"
                    ? ">80%"
                    : result.impliedGrowthBound === "below"
                      ? "<−30%"
                      : percent(result.impliedGrowth)
                }
              />
            </div>
          </Panel>
        </div>
      </div>
      <Panel
        title={t("增长 × 折现率", "Growth × cost of equity")}
        action={
          <span className="mx-unit">
            {result.horizon}
            {t(" 年", " years")} · {result.basis.currency}
          </span>
        }
      >
        <div
          className="mx-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t("二维敏感性矩阵", "Two-dimensional sensitivity matrix")}
        >
          <table className="mx-sensitivity-matrix">
            <thead>
              <tr>
                <th>{t("折现率 / 增长", "Discount / growth")}</th>
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
                      >
                        <strong>{number(cell.value, 2)}</strong>
                        <span>{percent(cell.upside, true, 1)}</span>
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        title={t("年度计算底稿", "Annual projection")}
        action={
          <Select
            aria-label={t("底稿情景", "Projection scenario")}
            value={worksheet}
            onChange={(v) => setWorksheet(v ?? "base")}
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
                <th>{t("增长", "Growth")}</th>
                <th>{t("营收", "Revenue")}</th>
                <th>{t("现金流率", "FCF margin")}</th>
                <th>{t("现金流", "Cash flow")}</th>
                <th>{t("股数", "Shares")}</th>
                <th>{t("每股现金流", "FCF / share")}</th>
                <th>{t("折现后每股值", "PV / share")}</th>
              </tr>
            </thead>
            <tbody>
              {projection.years.map((y) => (
                <tr key={y.year}>
                  <th>{y.year}</th>
                  <td>{percent(y.growth)}</td>
                  <td>{compact(y.revenue)}</td>
                  <td>{percent(y.fcfMargin)}</td>
                  <td>{compact(y.freeCashflow)}</td>
                  <td>{compact(y.shares)}</td>
                  <td>{number(y.cashflowPerShare, 2)}</td>
                  <td>{number(y.presentValue, 2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={6}>
                  {t("预测现金流现值", "Projected cash-flow present value")}
                </th>
                <td colSpan={2}>
                  {currency(
                    projection.operatingValue,
                    result.basis.currency,
                    2,
                  )}
                </td>
              </tr>
              <tr>
                <th colSpan={6}>
                  {t("终值现值", "Terminal present value")} ·{" "}
                  {percent(projection.terminalContribution)}
                </th>
                <td colSpan={2}>
                  {currency(
                    projection.terminalPresentValue,
                    result.basis.currency,
                    2,
                  )}
                </td>
              </tr>
              <tr>
                <th colSpan={6}>{t("每股价值", "Value per share")}</th>
                <td colSpan={2}>
                  {currency(projection.value, result.basis.currency, 2)}
                </td>
              </tr>
              {projection.equityFloorAdjustment > 0 && (
                <tr>
                  <th colSpan={6}>
                    {t("股权零下限调整", "Equity zero-floor adjustment")}
                  </th>
                  <td colSpan={2}>
                    {currency(
                      projection.equityFloorAdjustment,
                      result.basis.currency,
                      2,
                    )}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        <details className="mx-chart-data">
          <summary>{t("输入与来源", "Inputs & sources")}</summary>
          <dl className="mx-evidence-inputs">
            <dt>{t("起始营收", "Starting revenue")}</dt>
            <dd>{currency(result.basis.revenue, result.basis.currency, 0)}</dd>
            <dt>{t("起始现金流率", "Starting FCF margin")}</dt>
            <dd>{percent(result.basis.startMargin, false, 2)}</dd>
            <dt>{t("股数", "Shares outstanding")}</dt>
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
                  {reference.period} ·{" "}
                  {percent(
                    reference.referenceValue ?? reference.value,
                    false,
                    2,
                  )}
                  {!!reference.adjustment &&
                    ` · ${t("情景调整", "Scenario adjustment")} ${number(reference.adjustment * 100, 2)} pp`}
                </span>
                {(reference.evidence ?? []).map((e, j) =>
                  e.url ? (
                    <a key={j} href={e.url} rel="noreferrer" target="_blank">
                      {e.publishedAt ?? t("原始披露", "Original filing")} ↗
                    </a>
                  ) : null,
                )}
              </li>
            ))}
            {result.basis.evidence?.map((e, i) => (
              <li key={i}>
                <strong>{e.field}</strong>
                <span>{e.source}</span>
                {e.url && (
                  <a href={e.url} rel="noreferrer" target="_blank">
                    {t("原始披露", "Original filing")} ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      </Panel>
    </>
  );
}

function GrowthContext({
  data,
  analyst,
}: {
  data: ResearchLensSnapshot;
  analyst: Record<string, unknown>;
}) {
  const t = useCopy();
  const facts = data.financialFacts;
  const annual = (facts?.periods ?? [])
    .filter((p) => p.kind === "annual")
    .map((p) => ({
      date: p.providerEnd,
      value: facts?.observations.find(
        (o) => o.periodId === p.id && o.metric === "revenue",
      )?.value,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const filed = objects(object(data.researchEvidence).annualRevenue)
    .filter((o) => o.currency === facts?.currency)
    .map((o) => ({ date: str(o.periodEnd), value: numeric(o.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
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
    .sort((a, b) => b.providerEnd.localeCompare(a.providerEnd))[0];
  const yoy = facts?.observations.find(
    (o) => o.periodId === quarter?.id && o.metric === "revenueGrowth",
  )?.value;
  const next = objects(analyst.revenueEstimate).find(
    (r) => str(r.period ?? r.index) === "+1y",
  );
  return (
    <Panel
      className="mx-growth-context"
      title={t("营收增长参考", "Revenue-growth context")}
      help={t(
        "历史CAGR按所示年度收入跨度复算；最新季度同比与下一财年共识各用自己的期间。它们是参考，修改模型仍由你决定。",
        "Historical CAGR uses the available annual-revenue span. Latest-quarter YoY and next-fiscal-year consensus retain their own periods. These references do not overwrite your model inputs.",
      )}
    >
      <Facts
        rows={[
          [t("历史3年 CAGR", "Historical 3Y CAGR"), cagr(3)],
          [t("历史5年 CAGR", "Historical 5Y CAGR"), cagr(5)],
          [
            quarter
              ? `${quarter.label} ${t("同比", "YoY")}`
              : t("最新季度同比", "Latest-quarter YoY"),
            percent(yoy, true, 2),
          ],
          [
            t("下一财年共识", "Next fiscal-year consensus"),
            <span key="estimate">
              {percent(next?.growth, true, 2)}
              {next?.endDate ? ` · ${str(next.endDate)}` : ""}
            </span>,
          ],
        ]}
      />
    </Panel>
  );
}
