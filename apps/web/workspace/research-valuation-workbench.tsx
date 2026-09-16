"use client";

import type { ResearchLensSnapshot } from "@/lib/types";
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Textarea,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ValuationScenarioComparison } from "./valuation-scenario-comparison";
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
      <details className="mx-model-detail">
        <summary>{t("历史估值参考", "Historical valuation reference")}</summary>
        <FilingMultiples data={data} />
      </details>
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
  const [activeField, setActiveField] =
    useState<keyof ScenarioInput>("revenueCagr");
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<number | string | null>(null);
  const [invalidInput, setInvalidInput] = useState(false);
  const [reason, setReason] = useState("");
  const [worksheet, setWorksheet] = useState<string>("base");
  const [references, setReferences] = useState<
    NonNullable<Preview["references"]>
  >(initial.references ?? []);
  const reference = useQuery({
    ...researchLensQuery(initial.basis.ticker, "analyst", revision ?? data.runId),
  });
  const analyst = object(reference.data?.analyst);
  const estimate = objects(analyst.revenueEstimate).find(
    (r) => str(r.period ?? r.index) === params.get("estimateRef"),
  );
  const estimateGrowth = numeric(estimate?.growth);
  const liveRequest = useMemo(
    () => ({
      scenarios: inputs,
      horizon,
      dataVersion: initial.basis.dataVersion,
      references,
    }),
    [inputs, horizon, initial.basis.dataVersion, references],
  );
  const [debounced] = useDebouncedValue(liveRequest, 250);
  const liveFingerprint = JSON.stringify(liveRequest);
  const request = JSON.stringify(debounced);
  const query = useQuery({
    queryKey: ["valuation-preview", initial.id, request],
    queryFn: ({ signal }) =>
      api<Preview>(
        `/research/${encodeURIComponent(initial.basis.ticker)}/valuation-preview`,
        { ...jsonRequest("POST", debounced), signal },
      ),
    initialData: request === JSON.stringify({
      scenarios: Object.fromEntries(keys.map((k) => [k, initial.scenarios[k].inputs])),
      horizon: initial.horizon,
      dataVersion: initial.basis.dataVersion,
      references: initial.references ?? [],
    }) ? initial : undefined,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  const baseline = useQuery({
    queryKey: ["valuation-preview", initial.id, JSON.stringify({
      scenarios: Object.fromEntries(keys.map((k) => [k, initial.scenarios[k].inputs])),
      horizon,
      dataVersion: initial.basis.dataVersion,
      references: initial.references ?? [],
    })],
    queryFn: ({ signal }) =>
      api<Preview>(
        `/research/${encodeURIComponent(initial.basis.ticker)}/valuation-preview`,
        { ...jsonRequest("POST", {
          scenarios: Object.fromEntries(
            keys.map((k) => [k, initial.scenarios[k].inputs]),
          ),
          horizon,
          dataVersion: initial.basis.dataVersion,
          references: initial.references ?? [],
        }), signal },
      ),
    enabled: horizon !== initial.horizon,
    staleTime: Infinity,
    retry: false,
  });
  const initialAtHorizon =
    horizon === initial.horizon ? initial : baseline.data;
  const result = query.data ?? initial;
  const busy = invalidInput || query.isFetching || request !== liveFingerprint;
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const saved = savedFingerprint === liveFingerprint;
  const save = useMutation({
    mutationFn: (payload: typeof liveRequest & { reason: string }) =>
      api(
        `/research/${encodeURIComponent(initial.basis.ticker)}/models`,
        jsonRequest("POST", payload),
      ),
    onSuccess: async (_result, payload) => {
      setSavedFingerprint(
        JSON.stringify({
          scenarios: payload.scenarios,
          horizon: payload.horizon,
          dataVersion: payload.dataVersion,
          references: payload.references,
        }),
      );
      setSaveOpen(false);
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
  const current = result.scenarios[selected] ?? base;
  const sourceLabel =
    initial.defaultSource === "saved-model"
      ? t("上次保存的模型", "Last saved model")
      : initial.defaultSource === "sector-template"
        ? t("行业情景模板", "Sector scenario template")
        : initial.defaultSource === "configured-scenarios"
          ? t("已配置的假设", "Configured assumptions")
          : t("模型初始假设", "Initial assumptions");
  const referencePeriod = data.financialFacts?.periods.find(
    (p) => p.id === data.financialFacts?.latestTtm,
  );
  const latestFact = (metric: string) =>
    data.financialFacts?.observations.find(
      (o) =>
        o.periodId === data.financialFacts?.latestTtm && o.metric === metric,
    )?.value;
  const projection = result.scenarios[worksheet] ?? base;
  return (
    <>
      <div className="mx-model-reference-grid">
        <Panel
          title={t("经营参考", "Operating reference")}
          action={
            <span className="mx-unit">
              {referencePeriod?.label} · {result.basis.currency}
            </span>
          }
          help={t(
            "模型从最近四个完整季度的经营现金流减资本开支出发，使用股权资本成本。它是股权现金流代理，没有完整建模借款、偿债和回购融资；现金、债务不在结果上直接加减。目标现金流率在三年内逐渐达到；十年模式第六年起增长逐渐收敛至 3%。",
            "The model starts with operating cash flow less capital expenditure over four complete quarters and discounts at cost of equity. It is an equity cash-flow proxy, without a complete borrowing, repayment or buyback financing model. Cash and debt are not directly added or subtracted. Margins converge over three years; ten-year growth fades toward 3% from year six.",
          )}
        >
          <div className="mx-metric-grid">
            <Metric
              label={t("TTM 营收", "TTM revenue")}
              value={compact(result.basis.revenue)}
            />
            <Metric
              label={t("TTM 现金流率", "TTM cash-flow margin")}
              value={percent(result.basis.startMargin, false, 2)}
            />
          </div>
          <details className="mx-chart-data">
            <summary>
              {t("基数与资本结构", "Basis & capital structure")}
            </summary>
            <Facts
              rows={[
                [
                  t("模型股数", "Model share count"),
                  number(result.basis.shares, 0),
                ],
                [
                  t("现金及短期投资", "Cash & short-term investments"),
                  compact(latestFact("cash")) +
                    " " +
                    (data.financialFacts?.currency ?? ""),
                ],
                [
                  t("总债务", "Total debt"),
                  compact(latestFact("debt")) +
                    " " +
                    (data.financialFacts?.currency ?? ""),
                ],
              ]}
            />
            <a
              className="mx-text-link"
              href={`/research?ticker=${encodeURIComponent(data.ticker)}&view=fundamentals&financialMode=cash&frequency=ttm`}
            >
              {t("查看现金流与披露", "View cash flow & disclosures")} ↗
            </a>
          </details>
        </Panel>
        <GrowthContext data={data} analyst={analyst} />
      </div>
      <div className="mx-model-workbench" aria-busy={busy}>
        <div className="mx-model-output">
          <Panel
            title={t("情景估值", "Scenario valuation")}
            id="valuation-results"
            action={
              <Group gap="xs">
                <Button
                  className="mx-model-jump"
                  component="a"
                  href="#valuation-assumptions"
                  variant="subtle"
                  size="compact-xs"
                >
                  {t("调整假设", "Adjust assumptions")}
                </Button>
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
                  {invalidInput
                    ? t("请完成输入", "Complete the input")
                    : busy
                      ? t("计算中…", "Calculating…")
                      : ""}
                </span>
              </Group>
            }
          >
            <ValuationScenarioComparison
              preview={result}
              selected={selected}
              onSelect={(key) => {
                setSelected(key);
                setDraftValue(null);
                setInvalidInput(false);
              }}
            />
            {initialAtHorizon &&
              !busy &&
              !query.isError &&
              inputs[selected] &&
              JSON.stringify(inputs[selected]) !==
                JSON.stringify(initial.scenarios[selected].inputs) && (
                <div className="mx-model-change" role="status">
                  <span>
                    {scenarioNames[selected]} ·{" "}
                    {t("相对初始假设", "vs initial assumptions")}
                  </span>
                  <strong>
                    {currency(
                      current.value -
                        initialAtHorizon.scenarios[selected].value,
                      result.basis.currency,
                      2,
                    )}{" "}
                    / {t("股", "share")}
                  </strong>
                </div>
              )}
            {query.isError && (
              <p role="alert">
                {t(
                  "预览计算失败，当前仍为上次结果。",
                  "Preview failed. The previous result is retained.",
                )}
              </p>
            )}
            <details className="mx-disclosure">
              <summary>{t("比较情景假设", "Compare scenario assumptions")}</summary>
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
            </details>
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
        <Panel
          title={t("调整假设", "Adjust assumptions")}
          id="valuation-assumptions"
          action={
            <Button
              className="mx-model-jump"
              component="a"
              href="#valuation-results"
              variant="subtle"
              size="compact-xs"
            >
              {t("查看结果", "View results")}
            </Button>
          }
          className="mx-model-inputs"
          help={t(
            "现金流来自四季报表的经营现金流减资本开支，作为股权现金流代理，与股权资本成本配对。十年模型从第六年逐渐收敛至 3% 增长。",
            "Cash flow is reported operating cash flow less capital expenditure, used as an equity cash-flow proxy with cost of equity. In the ten-year model, growth fades toward 3% from year six.",
          )}
        >
          <Segments
            label={t("编辑情景", "Edit scenario")}
            value={selected}
            onChange={(v) => {
              setSelected(v);
              setDraftValue(null);
              setInvalidInput(false);
            }}
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
                  setActiveField("revenueCagr");
                  setDraftValue(null);
                  setInvalidInput(false);
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
          <div
            className="mx-assumption-picker"
            aria-label={t("选择要调整的假设", "Choose an assumption to adjust")}
          >
            {fields.map((field) => (
              <button
                key={field.key}
                type="button"
                aria-pressed={activeField === field.key}
                onClick={() => {
                  setActiveField(field.key);
                  setDraftValue(null);
                  setInvalidInput(false);
                }}
              >
                <span>{field.label}</span>
                <strong>
                  {number(inputs[selected][field.key] * field.scale, 2)}
                  {field.suffix}
                </strong>
              </button>
            ))}
          </div>
          <div className="mx-model-fields">
            {fields
              .filter((field) => field.key === activeField)
              .map((field) => (
                <NumberInput
                  key={selected + field.key}
                  label={field.label}
                  value={
                    draftValue ??
                    Number(
                      (inputs[selected][field.key] * field.scale).toFixed(3),
                    )
                  }
                  error={
                    invalidInput
                      ? `${t("请输入", "Enter a value between ")}${field.min} – ${field.max}${field.suffix}`
                      : undefined
                  }
                  onChange={(v) => {
                    setDraftValue(v);
                    const value = numeric(v);
                    setInvalidInput(
                      value == null || value < field.min || value > field.max,
                    );
                    if (
                      value != null &&
                      value >= field.min &&
                      value <= field.max
                    ) {
                      setInputs((previous) => ({
                        ...previous,
                        [selected]: {
                          ...previous[selected],
                          [field.key]: value / field.scale,
                        },
                      }));
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
          <details className="mx-model-sources">
            <summary>{t("参数依据", "Assumption sources")}</summary>
            <Facts
              rows={fields.map((field) => {
                const ref = references.find((r) => r.scenario === selected);
                const changed =
                  inputs[selected][field.key] !==
                  initial.scenarios[selected].inputs[field.key];
                return [
                  field.label,
                  field.key === "revenueCagr" && ref
                    ? `${ref.source === "historical-revenue-cagr" ? t("历史营收 CAGR", "Historical revenue CAGR") : t("营收共识", "Revenue consensus")} · ${ref.period}`
                    : changed
                      ? t("本次调整", "Current edit")
                      : sourceLabel,
                ];
              })}
            />
            <p>
              {t(
                "增长先应用五年；目标现金流率用三年达到。股数变化为负表示减少；终值倍数与股权资本成本是情景假设。",
                "Growth applies for five years and the target margin is reached over three. Negative share-count change means fewer shares. The terminal multiple and cost of equity are scenario assumptions.",
              )}
            </p>
          </details>
          <Button
            variant="subtle"
            onClick={() => {
              setDraftValue(null);
              setInvalidInput(false);
              setInputs(
                Object.fromEntries(
                  keys.map((k) => [k, initial.scenarios[k].inputs]),
                ),
              );
              setReferences(initial.references ?? []);
            }}
          >
            {t("重置假设", "Reset assumptions")}
          </Button>
          <Button
            fullWidth
            onClick={() => setSaveOpen(true)}
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
      </div>
      <details className="mx-model-detail">
        <summary>{t("敏感性分析", "Sensitivity analysis")}</summary>
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
            aria-label={t(
              "二维敏感性矩阵",
              "Two-dimensional sensitivity matrix",
            )}
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
      </details>
      <details className="mx-model-detail">
        <summary>
          {t("年度计算底稿与来源", "Annual worksheet & sources")}
        </summary>
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
              <dd>
                {currency(result.basis.revenue, result.basis.currency, 0)}
              </dd>
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
      </details>
      <Modal
        opened={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={t("保存模型版本", "Save model version")}
      >
        <Facts
          rows={[
            [t("模型周期", "Horizon"), `${horizon}Y`],
            [
              scenarioNames[selected],
              currency(current.value, result.basis.currency, 2),
            ],
          ]}
        />
        <Textarea
          label={t("记录这次判断的理由", "Reason for this view")}
          placeholder={t(
            "例如：增长回归历史均值，现金流率保持稳定。",
            "For example: growth returns to its historical average while the cash-flow margin holds.",
          )}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          minRows={3}
          maxLength={4000}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setSaveOpen(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            onClick={() => save.mutate({ ...liveRequest, reason })}
            loading={save.isPending}
            disabled={busy || query.isError}
          >
            {t("保存版本", "Save version")}
          </Button>
        </Group>
        {save.isError && (
          <p role="alert">
            {t("保存失败，请重试。", "Could not save. Try again.")}
          </p>
        )}
      </Modal>
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
