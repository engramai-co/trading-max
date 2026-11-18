"use client";

import { useBuildNavigationGuard } from "@/ui/publication-provider";
import type { ResearchLensSnapshot } from "@/lib/types";
import {
  Button,
  Group,
  Modal,
  Select,
  NumberInput,
  Textarea,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { ArrowClockwise } from "@phosphor-icons/react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRetainedResult } from "./retained-result";
import { useLocale } from "@/components/locale-provider";
import { DraftEvidence, DraftStatus, ProposalRow, useDraftPreferences, useValuationDraft } from "./valuation-draft-editor";
import { draftBlockMessage, inputKey, reverseDraftBlock, type DraftReview } from "./valuation-draft";
import { ValuationScenarioComparison } from "./valuation-scenario-comparison";
import {
  ApiError,
  api,
  compact,
  currency,
  jsonRequest,
  number,
  object,
  objects,
  percent,
  str,
} from "@/workspace/data";
import { formatCurrency } from "@/ui/formatters";
import { numeric } from "@/lib/numeric";
import {
  Empty,
  Facts,
  Metric,
  Panel,
  Pending,
  QueryError,
  Segments,
  Tag,
  useCopy,
} from "./foundation";
import type { Preview, ScenarioInput } from "./research-facts";
import type { ResearchPrice } from "./research-price-basis";
import {
  FilingMultiples,
  ModelAlternatives,
} from "./research-valuation-context";
import { GrowthContext, ValuationSensitivity, ValuationWorksheet } from "./research-valuation-detail";
import { researchLensQuery } from "./research-queries";
import { useRouteState } from "./route-state";
import { ResearchReading, valuationSections } from "./research-reading";
import { ValuationReadout, type ModelReading } from "./research-valuation-readout";
import { PeHistoryChart } from "./research-pe-history";
import {
  editorIdentity,
  loadedValuationQuery,
  previewRequest,
  valuationDefaultsQuery,
  valuationPreviewQuery,
  workbenchState,
} from "./valuation-queries";

const keys = ["bear", "base", "bull"] as const;
type Scenarios = Record<string, ScenarioInput>;
type EditorValues = { inputs: Scenarios; references: NonNullable<Preview["references"]> };
type ManualChanges = { fields: Record<string, Partial<ScenarioInput>>; references: EditorValues["references"] };

function initialValues(preview: Preview, changes?: ManualChanges): EditorValues {
  const inputs = Object.fromEntries(keys.map(key => [key, { ...preview.scenarios[key].inputs, ...changes?.fields[key] }]));
  const references = (preview.references ?? []).filter(r => changes?.fields[r.scenario]?.revenueCagr === undefined);
  return { inputs, references: [...references, ...(changes?.references ?? [])] };
}

function modelMethodology(initial: Preview, t: ReturnType<typeof useCopy>) {
  return initial.formulaVersion === "equity-proxy-projection-v1"
    ? t("保存的公式按三年调整利润率，股数按年度股数变化调整。", "The saved formula moves margin to its target over three years and applies the assumed annual share-count change.")
    : initial.basis.family === "residual-income"
    ? t(
        "期初普通股每股净资产加上剩余收益现值。ROE 逐年回归股权成本，期末按市净率结算。",
        "Starting common book value plus discounted residual earnings. ROE fades to the cost of equity and the terminal price uses P/B.",
      )
    : initial.basis.family === "net-income"
      ? t(
          "以普通股净利润作为收益代理。客户资金进出不计入估值。",
          "Common earnings proxy the amount available to shareholders. Client cash movements are excluded.",
        )
      : t(
          "经营现金流减资本开支，按股权成本折现。现金不足时按起始股价发行新股，后续收益由更多股份分摊。",
          "Operating cash flow less capital expenditure is discounted at the cost of equity. Burn beyond opening cash is financed by shares issued at the starting price.",
        );
}

function statementPeriod(result: Preview, data: ResearchLensSnapshot, t: ReturnType<typeof useCopy>) {
  const referencePeriod = data.financialFacts?.periods.find(
    (p) => p.id === (result.basis.periodId ?? data.financialFacts?.latestTtm),
  );
  const choice = result.basis.periodChoice;
  const label = choice === "previous-four-quarters" ? t("上个完整四季", "Earlier complete four quarters")
    : choice === "latest-fiscal-year" ? t("上一财年", "Last fiscal year")
      : choice === "previous-fiscal-year" ? t("较早完整财年", "Earlier complete fiscal year")
        : referencePeriod?.label;
  const end = referencePeriod?.actualEnd ?? referencePeriod?.providerEnd ?? result.basis.periodId?.split(":")[1];
  return [label, end, result.basis.currency].filter(Boolean).join(" · ");
}

export function ValuationWorkbench({
  data,
  revision,
  price,
}: {
  data: ResearchLensSnapshot;
  revision?: string | null;
  price?: ResearchPrice;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const [family, setFamily] = useState<Preview["basis"]["family"]>();
  const query = useQuery(valuationDefaultsQuery(data, price, family));
  // Once this research has a preview, a failed refresh keeps it and its editor.
  const loaded = useQuery(loadedValuationQuery(data, family));
  const state = workbenchState(query, loaded.data);
  const [dirty, setDirty] = useState(false);
  const [reload, setReload] = useState(0);
  const [recovered, setRecovered] = useState<{ id: string; changes: ManualChanges }>();
  const retained = useRetainedResult(state.view === "editor" ? state.preview : undefined, Object.is,
    (next, previous) => !dirty || next.basis.ticker !== previous.basis.ticker || editorIdentity(next) === editorIdentity(previous));
  const preview = retained?.basis.ticker === data.ticker && (!family || retained.basis.family === family)
    ? retained : undefined;
  const [reading, setReading] = useState<ModelReading>();
  const reverseOnly = preview?.reverseMetric === "year-five-revenue";
  // Keep the previous layout while a new family loads, so its selector stays in view.
  // Only the requested family's values and controls are available to the reader.
  const switching = !preview && state.view === "pending" && retained?.basis.ticker === data.ticker;
  const model = preview ?? (switching ? retained : undefined);
  const editor = model?.reverseMetric === "year-five-revenue" ? undefined : model;
  const methodology = editor && modelMethodology(editor, t);
  const selector = useRef<HTMLInputElement>(null);
  const position = useRef<{ selectorTop: number } | { scrollY: number } | null>(null);
  useLayoutEffect(() => {
    const input = selector.current;
    const saved = position.current;
    if (!saved || !input) return;
    if (document.activeElement === input) {
      if ("selectorTop" in saved) {
        window.scrollBy({ top: input.getBoundingClientRect().top - saved.selectorTop, behavior: "instant" });
      } else {
        // WebKit can clamp the reader's scroll position while replacing the results.
        window.scrollTo({ top: saved.scrollY, behavior: "instant" });
      }
    }
    if (!switching || document.activeElement !== input) {
      position.current = null;
      return;
    }
    const alignedY = window.scrollY;
    const recordScroll = () => {
      if (window.scrollY !== alignedY || (position.current && "scrollY" in position.current))
        position.current = { scrollY: window.scrollY };
    };
    window.addEventListener("scroll", recordScroll, { passive: true });
    return () => window.removeEventListener("scroll", recordScroll);
  }, [family, model, switching]);
  const [output, setOutput] = useState<HTMLDivElement | null>(null);
  const [reference, setReference] = useState<HTMLDivElement | null>(null);
  const currentReading = reading?.initial === preview ? reading : undefined;
  const chooser = (
    <Select
      ref={selector}
      label={t("估值模型", "Valuation model")}
      value={family ?? preview?.basis.family ?? null}
      placeholder={t("自动选择", "Automatic")}
      allowDeselect={false}
      data={[
        { value: "cash-flow", label: t("股权现金流", "Equity cash flow") },
        { value: "net-income", label: t("净利润", "Net income") },
        { value: "residual-income", label: t("剩余收益", "Residual income") },
      ]}
      onChange={(value) => {
        position.current = selector.current ? { selectorTop: selector.current.getBoundingClientRect().top } : null;
        setDirty(false);
        setRecovered(undefined);
        setFamily(value as Preview["basis"]["family"]);
      }}
    />
  );
  const reason = query.error instanceof ApiError && query.error.status === 422 ? query.error.message : null;
  const prefs = useDraftPreferences();
  const [draftAction, setDraftAction] = useState<HTMLSpanElement | null>(null);
  const block = reason ?? (preview && reverseDraftBlock(preview));

  const blockedMessage = block && draftBlockMessage(block, t, "complete-ttm-currency-and-share-count-required");

  return <ResearchReading parameter="valuationView" sections={editor ? valuationSections : valuationSections.slice(0, 2)}>
    <ValuationReadout data={data} preview={preview} reading={currentReading}
      retry={query.isError ? query.refetch : undefined} refreshing={query.isFetching} />
    <div id="research-history">
      <PeHistoryChart key={data.ticker} trailing={data.trailingPeHistory} forward={data.forwardPeHistory}
        sales={<FilingMultiples data={data} price={price} mode="ps" />}
        disclosure={<FilingMultiples data={data} price={price} mode="pe" />} />
    </div>
    <div id="research-scenario" className={editor ? "mx-model-workbench" : undefined}
      aria-busy={switching || currentReading?.busy} data-switching={switching || undefined}>
      {editor && <div className="mx-model-output" ref={setOutput} inert={switching} />}
      <Panel title={editor ? t("调整假设", "Adjust assumptions") : t("情景模型", "Scenario model")}
        id="valuation-assumptions" className="mx-model-inputs" help={methodology}
        action={<Group gap="xs">
          {prefs.enabled && <span ref={setDraftAction}>
            {!editor && block && <Button variant="default" size="compact-xs" disabled aria-describedby="valuation-draft-block">{t("✦ 起草", "✦ Draft")}</Button>}
          </span>}
          {editor && <Button className="mx-model-jump" component="a" href="#valuation-results"
          variant="subtle" size="compact-xs">{t("查看结果", "View results")}</Button>}
        </Group>}>
        {chooser}
        {editor ? <div className="mx-model-fields" inert={switching}>
          <ModelEditor key={reload + editorIdentity(editor)}
            requestedFamily={family} currentBasis={state.view === "editor" && !query.isError ? state.preview.id : null}
            draftAction={!switching ? draftAction : null} prefs={prefs} defaultBlock={block ?? null}
            recovered={recovered?.id === editor.id ? recovered.changes : undefined}
            reloadBasis={async changes => {
              const result = await query.refetch();
              if (result.isSuccess) {
                const next = result.data;
                setRecovered(next.basis.ticker === editor.basis.ticker && next.basis.family === editor.basis.family
                  ? { id: next.id, changes } : undefined);
                setDirty(false);
                setReload(n => n + 1);
              }
            }}
            initial={editor} output={output} referencePanel={reference}
            onDirty={setDirty} onReading={setReading} data={data} revision={revision}
            methodology={methodology} refreshing={query.isFetching}
            onRetry={query.isError ? () => void query.refetch() : undefined} />
        </div> : reverseOnly && preview ? <Facts rows={[
          [t("期间", "Period"), statementPeriod(preview, data, t)],
          [t("第五年隐含营收", "Implied year-five revenue"), formatCurrency(preview.reverseValue, locale, preview.basis.currency)],
          [t("股权成本", "Cost of equity"), percent(preview.reverseInputs?.discountRate)],
          [t("股数变化", "Share change"), percent(preview.reverseInputs?.shareCagr)],
        ]} /> : state.view === "error" ? (
          reason ? <div id="valuation-draft-block"><Empty title={blockedMessage} /></div> : <QueryError error={query.error} retry={query.refetch} />
        ) : <Pending />}
        {reverseOnly && prefs.enabled && block && <p id="valuation-draft-block" className="mx-draft-status">{blockedMessage}</p>}
      </Panel>
      {editor && <div className="mx-model-reference-grid" ref={setReference} inert={switching} />}
      {!preview && state.view === "error" && <ModelAlternatives data={data} financial={family === "residual-income"} />}
    </div>
    {editor && !switching && <ModelDetails key={editorIdentity(editor)} result={currentReading?.result ?? editor} />}
  </ResearchReading>;
}

function ModelEditor({
  draftAction, prefs, defaultBlock,
  output,
  referencePanel,
  methodology,
  initial,
  onReading,
  requestedFamily,
  currentBasis,
  recovered,
  reloadBasis,
  onDirty,
  data,
  revision,
  refreshing,
  onRetry,
}: {
  draftAction: HTMLSpanElement | null;
  prefs: ReturnType<typeof useDraftPreferences>;
  defaultBlock: string | null;
  output: HTMLDivElement | null;
  referencePanel: HTMLDivElement | null;
  methodology?: string;
  initial: Preview;
  onReading: (reading: ModelReading) => void;
  requestedFamily?: Preview["basis"]["family"];
  currentBasis: string | null;
  recovered?: ManualChanges;
  reloadBasis: (changes: ManualChanges) => Promise<void>;
  onDirty: (dirty: boolean) => void;
  data: ResearchLensSnapshot;
  revision?: string | null;
  /** The default preview is being refetched, as after a broker refresh. */
  refreshing: boolean;
  /** Offered when that refetch failed; the last preview stays meanwhile. */
  onRetry?: () => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const client = useQueryClient();
  const { params, update } = useRouteState("push");
  const horizon = params.has("horizon")
    ? params.get("horizon") === "10"
      ? 10
      : 5
    : initial.horizon;
  const [inputs, setInputs] = useState<Scenarios>(() => initialValues(initial, recovered).inputs);
  const drafting = useValuationDraft(initial, requestedFamily, horizon, inputs, data.runId, prefs, currentBasis);
  const { draft } = drafting;
  const [editingProposal, setEditingProposal] = useState<string | null>(null);
  const focusField = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusField.current) return;
    document.getElementById("assumption-" + focusField.current)?.focus();
    focusField.current = null;
  });
  const residual = initial.basis.family === "residual-income";
  const earnings = initial.basis.family === "net-income";
  const marginLabel = earnings || residual ? t("净利率", "Net margin") : t("现金流率","FCF margin");
  const [selected, setSelected] = useState<string>("base");
  const [activeField, setActiveField] =
    useState<keyof ScenarioInput>(residual ? "initialRoe" : "revenueCagr");
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<number | string | null>(null);
  const [invalidInput, setInvalidInput] = useState(false);
  const [reason, setReason] = useState("");
  const [references, setReferences] = useState<
    NonNullable<Preview["references"]>
  >(() => initialValues(initial, recovered).references);
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
      family: initial.basis.family,
      formulaVersion: initial.formulaVersion,
      scenarios: inputs,
      horizon,
      dataVersion: initial.basis.dataVersion,
      references,
    }),
    [inputs, horizon, initial.basis.dataVersion, initial.basis.family, initial.formulaVersion, references],
  );
  const [debounced] = useDebouncedValue(liveRequest, 250);
  const liveFingerprint = JSON.stringify(liveRequest);
  const request = JSON.stringify(debounced);
  const query = useQuery({
    ...valuationPreviewQuery(initial, debounced),
    initialData: request === JSON.stringify(previewRequest(initial)) ? initial : undefined,
    placeholderData: keepPreviousData,
  });
  const baseline = useQuery({
    ...valuationPreviewQuery(initial, previewRequest(initial, horizon)),
    enabled: horizon !== initial.horizon,
  });
  const initialAtHorizon =
    horizon === initial.horizon ? initial : baseline.data;
  const result = query.data ?? initial;
  const busy =
    invalidInput || refreshing || query.isFetching || request !== liveFingerprint;
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const saved = savedFingerprint === liveFingerprint;
  const dirty = Boolean(draft) || saveOpen || invalidInput || !saved && (
    draftValue !== null || liveFingerprint !== JSON.stringify(previewRequest(initial)));
  useBuildNavigationGuard(dirty);
  useLayoutEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const save = useMutation({
    mutationFn: (payload: typeof liveRequest & { reason: string; draftReview?: DraftReview }) =>
      api(
        `/research/${encodeURIComponent(initial.basis.ticker)}/models`,
        jsonRequest("POST", payload),
      ),
    onSuccess: async (_result, payload) => {
      setSavedFingerprint(
        JSON.stringify({
          family: payload.family,
          formulaVersion: payload.formulaVersion,
          scenarios: payload.scenarios,
          horizon: payload.horizon,
          dataVersion: payload.dataVersion,
          references: payload.references,
        }),
      );
      setSaveOpen(false);
      drafting.reset();
      if (payload.draftReview) await client.invalidateQueries({ queryKey: ["valuation-workbench", initial.basis.ticker] });
      await client.invalidateQueries({
        queryKey: ["workspace-valuation-assumptions"],
      });
      await client.invalidateQueries({
        queryKey: ["research-journal", initial.basis.ticker],
      });
    },
  });
  const failedBlock = drafting.error && draftBlockMessage(drafting.error, t) ? drafting.error : null;
  const draftBlock = defaultBlock ?? failedBlock ?? (query.error instanceof ApiError && query.error.status === 422
    ? query.error.message : reverseDraftBlock(result));
  const basisChanged = currentBasis !== initial.id;
  const staleDraft = drafting.stale || Boolean((draft || dirty) && currentBasis && basisChanged) ||
    Boolean(draft && (!currentBasis || [query.error, save.error].some(e => e instanceof ApiError && [409, 422].includes(e.status))));
  function unstageAccepted(): EditorValues {
    const manual = Object.fromEntries(keys.map(k => [k, { ...inputs[k] }]));
    let refs = references;
    if (draft) for (const p of draft.result.proposals) {
      if (draft.review.decisions[p.scenario][p.field] !== "accepted") continue;
      const key = inputKey[p.field];
      Object.assign(manual[p.scenario], { [key]: draft.before.scenarios[p.scenario].inputs[key] });
      if (key === "revenueCagr") refs = [...refs.filter(r => r.scenario !== p.scenario),
        ...(draft.before.references ?? []).filter(r => r.scenario === p.scenario)];
    }
    return { inputs: manual, references: refs };
  }
  function discardDraft() {
    const manual = unstageAccepted();
    setInputs(manual.inputs);
    setReferences(manual.references);
    setDraftValue(null);
    setInvalidInput(false);
    setEditingProposal(null);
    drafting.reset();
    save.reset();
  }
  function reloadForReview() {
    const manual = unstageAccepted();
    const fields = Object.fromEntries(keys.map(k => [k, Object.fromEntries(
      Object.entries(manual.inputs[k]).filter(([field, value]) =>
        value !== initial.scenarios[k].inputs[field as keyof ScenarioInput])
    )]));
    void reloadBasis({ fields, references: manual.references.filter(r => "revenueCagr" in fields[r.scenario]) });
  }
  const reReview = staleDraft && <div className="mx-draft-status" role="alert">
    {t("估值口径或父模型已改变。", "The valuation basis or parent model changed.")}{" "}
    <button type="button" className="mx-text-link" onClick={reloadForReview}>
      {t("重新载入并重审", "Reload for review")}
    </button>
  </div>;
  const changes = draft?.result.proposals.filter(p => p.value !== draft.before.scenarios[p.scenario].inputs[inputKey[p.field]]) ?? [];
  const accepted = changes.filter(p => draft?.review.decisions[p.scenario][p.field] === "accepted").length;
  const reviewed = changes.some(p => draft?.review.decisions[p.scenario][p.field] !== "unreviewed");
  const stagedScenarios = [...new Set(changes.filter(p => !reviewed ||
    ["accepted", "edited"].includes(draft!.review.decisions[p.scenario][p.field])).map(p => p.scenario))];
  const comparison = draft && !reviewed ? { ...result, scenarios: Object.fromEntries(
    Object.entries(result.scenarios).map(([key, row]) => [key, {...row, ...draft.result.deskReadings[key]}]),
  ) } : result;
  const scenarioNames: Record<string, string> = {
    bear: t("保守", "Bear"),
    base: t("中性", "Base"),
    bull: t("乐观", "Bull"),
  };
  const fields: {
    key: keyof ScenarioInput;
    label: string;
    min: number;
    max: number;
    scale: number;
    suffix: string;
  }[] = residual ? [
    {key:"initialRoe",label:t("第一年 ROE","Year-one ROE"),min:-80,max:200,scale:100,suffix:"%"},
    {key:"payout",label:t("派息率","Payout ratio"),min:0,max:100,scale:100,suffix:"%"},
    {key:"discountRate",label:t("股权资本成本","Cost of equity"),min:1,max:60,scale:100,suffix:"%"},
    {key:"terminalPb",label:t("终值市净率","Terminal P/B"),min:0,max:15,scale:1,suffix:"×"},
  ] : [
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
      label: earnings ? t("目标净利率","Target net margin") : t("目标现金流率", "Target FCF margin"),
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
      label: earnings ? t("终值市盈率","Terminal P/E") : t("终值现金流倍数", "Terminal FCF multiple"),
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
  if (!residual && initial.formulaVersion !== "equity-proxy-projection-v1")
    fields.push({
      key: "rampYears",
      label: t("达到目标的年数", "Years to target margin"),
      min: 1,
      max: 10,
      scale: 1,
      suffix: "",
    });
  const base = result.scenarios.base;


  const current = result.scenarios[selected] ?? base;
  const sourceLabel =
    initial.defaultSource === "saved-model"
      ? t("上次保存的模型", "Last saved model")
      : initial.defaultSource === "sector-template"
        ? t("板块情景模板", "Sector scenario template")
        : initial.defaultSource === "configured-scenarios"
          ? t("已配置的假设", "Configured assumptions")
          : t("模型初始假设", "Initial assumptions");
  const latestFact = (metric: string) =>
    data.financialFacts?.observations.find(
      (o) =>
        o.periodId === (result.basis.periodId ?? data.financialFacts?.latestTtm) && o.metric === metric,
    )?.value;
  const editedBase = JSON.stringify(base.inputs) !== JSON.stringify(initial.scenarios.base.inputs);
  const stale = Boolean(onRetry) || query.isError;
  useLayoutEffect(() => {
    onReading({ initial, result, edited: editedBase, source: sourceLabel, stale, busy });
  }, [initial, result, editedBase, sourceLabel, stale, busy, onReading]);
  return (
    <>
      {draftAction && createPortal(draft ? <Button variant="default" size="compact-xs" onClick={discardDraft}>
        {t("放弃草稿", "Discard draft")}
      </Button> : <Button variant="default" size="compact-xs"
        aria-describedby={draftBlock ? "valuation-draft-block" : undefined}
        disabled={!drafting.phase && (busy || stale || staleDraft || basisChanged || Boolean(draftBlock))}
        onClick={() => { if (drafting.phase) drafting.cancel(); else { setEditingProposal(null); void drafting.start(result); } }}>
        {drafting.phase ? t("取消起草", "Cancel draft") : initial.defaultSource === "saved-model"
          ? t("✦ 看新证据", "✦ Review new evidence") : t("✦ 起草", "✦ Draft")}
      </Button>, draftAction)}
      {drafting.enabled && draftBlock && <p className="mx-draft-status" id="valuation-draft-block">{draftBlockMessage(draftBlock, t, "complete-ttm-currency-and-share-count-required")}</p>}
      {output && createPortal(
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
                  label={t("预测年限", "Horizon")}
                  value={String(horizon)}
                  onChange={(v) => update({ horizon: v })}
                  options={[
                    { value: "5", label: t("5 年", "5 years") },
                    { value: "10", label: t("10 年", "10 years") },
                  ]}
                />
                <span role="status" className="mx-preview-status">
                  {invalidInput ? t("请完成输入", "Complete the input") : busy ? t("计算中…", "Calculating…") : ""}
                </span>
              </Group>
            }
          >
            <ValuationScenarioComparison
              preview={comparison}
              beforeDraft={draft?.before}
              stagedScenarios={stagedScenarios}
              calculatingDraft={busy || query.isError || staleDraft}
              selected={selected}
              onSelect={(key) => {
                setSelected(key);
                setDraftValue(null);
                setInvalidInput(false);
              }}
            />
            {onRetry && !refreshing && (
              <div className="mx-model-refresh" role="alert">
                <Tag tone="warn">{t("未能按最新价格重算", "Not revalued at the latest price")}</Tag>
                <Button
                  variant="subtle"
                  size="compact-xs"
                  leftSection={<ArrowClockwise size={12} />}
                  onClick={onRetry}
                >
                  {t("重试", "Retry")}
                </Button>
              </div>
            )}
            {initialAtHorizon &&
              !busy &&
              !query.isError &&
              inputs[selected] &&
              JSON.stringify(inputs[selected]) !== JSON.stringify(initial.scenarios[selected].inputs) && (
                <div className="mx-model-change" role="status">
                  <span>
                    {scenarioNames[selected]} · {t("相对初始假设", "vs initial assumptions")}
                  </span>
                  <strong>
                    {currency(
                      current.value - initialAtHorizon.scenarios[selected].value,
                      result.basis.currency,
                      2,
                    )}{" "}
                    / {t("股", "share")}
                  </strong>
                </div>
              )}
            {query.isError && (
              <p role="alert">
                {t("预览计算失败，当前仍为上次结果。", "Preview failed. The previous result is retained.")}
              </p>
            )}
            <details className="mx-disclosure">
              <summary>{t("比较情景假设", "Compare scenario assumptions")}</summary>
              <div
                className="mx-table-scroll"
                tabIndex={0}
                role="region"
                aria-label={t("情景对比", "Scenario comparison")}
              >
                <table className="mx-financial-table">
                  <thead>
                    <tr>
                      <th>{t("情景", "Scenario")}</th>
                      <th>{residual ? "ROE" : t("增长", "Growth")}</th>
                      <th>{residual ? t("派息率", "Payout") : marginLabel}</th>
                      <th>{t("折现率", "Discount")}</th>
                      <th>{t("价值", "Value")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k}>
                        <th>{scenarioNames[k]}</th>
                        <td>
                          {percent(
                            residual
                              ? result.scenarios[k].inputs.initialRoe
                              : result.scenarios[k].inputs.revenueCagr,
                          )}
                        </td>
                        <td>
                          {percent(
                            residual
                              ? result.scenarios[k].inputs.payout
                              : result.scenarios[k].inputs.targetFcfMargin,
                          )}
                        </td>
                        <td>{percent(result.scenarios[k].inputs.discountRate)}</td>
                        <td>{currency(result.scenarios[k].value, result.basis.currency, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </Panel>, output)}
          {draft && !drafting.phase && <p className="mx-draft-status" role="status">{changes.length ?
            t("{changes} 处改动 · 已接受 {accepted}", "{changes} proposed · {accepted} accepted").replace("{changes}", String(changes.length)).replace("{accepted}", String(accepted)) :
            t("此次起草保留了当前假设。", "The draft retains the current assumptions.")}</p>}
          <DraftStatus phase={drafting.phase} error={failedBlock ? null : drafting.error} />
          {reReview}
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
          {!residual && params.get("estimateRef") && (
            <div className="mx-model-reference">
              <strong>{t("营收增长参考", "Revenue-growth reference")}</strong>
              <p>
                {str(estimate?.endDate || params.get("estimateRef"))} · {percent(estimateGrowth, true)}
              </p>
              <Button
                variant="light"
                size="xs"
                disabled={estimateGrowth == null || estimateGrowth < -0.8 || estimateGrowth > 2}
                onClick={() => {
                  if (estimateGrowth == null) return;
                  const p = draft?.result.proposals.find(p => p.scenario === selected && p.field === "revenue_cagr");
                  if (p) drafting.decide(p, "edited");
                  setInputs((v) => ({
                    ...v,
                    [selected]: { ...v[selected], revenueCagr: estimateGrowth },
                  }));
                  setReferences((v) => [
                    ...v.filter((r) => r.scenario !== selected),
                    {
                      metric: "revenueGrowth",
                      scenario: selected as "bear" | "base" | "bull",
                      period: str(estimate?.endDate || params.get("estimateRef")),
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
                {t("设为当前情景的前五年增长", "Apply to years 1–5 of this scenario")}
              </Button>
            </div>
          )}
          <div
            className="mx-assumption-picker"
            role="group"
            aria-label={t("选择要调整的假设", "Choose an assumption to adjust")}
          >
            {fields.map((field) => {
              const p = draft?.result.proposals.find(p => p.scenario === selected && inputKey[p.field] === field.key);
              const decision = p && draft?.review.decisions[selected][p.field];
              const old = draft?.before.scenarios[selected].inputs[field.key];
              if (draft && p && p.value !== old && decision !== "rejected" && decision !== "edited" &&
                editingProposal !== selected + field.key) {
                return <ProposalRow key={field.key} draft={draft} proposal={p} label={field.label} scale={field.scale} suffix={field.suffix} disabled={staleDraft}
                  edit={() => { focusField.current = field.key; setActiveField(field.key); setEditingProposal(selected + field.key); setDraftValue(null); setInvalidInput(false); }}
                  decide={next => {
                    if (next === "rejected") focusField.current = field.key;
                    drafting.decide(p, next);
                    setDraftValue(null);
                    setInvalidInput(false);
                    setInputs(prev => ({ ...prev, [selected]: { ...prev[selected], [field.key]: next === "accepted" ? p.value : old } }));
                    if (field.key === "revenueCagr") {
                      setReferences(refs => [
                        ...refs.filter(r => r.scenario !== selected),
                        ...(next === "rejected" ? (draft.before.references ?? []).filter(r => r.scenario === selected) : []),
                      ]);
                    }
                  }} />;
              }
              return field.key === activeField ? (
                // The selected row is the input; its label names the field once.
                <div key={field.key} className="mx-assumption-edit">
                  <label htmlFor={"assumption-" + field.key}>{field.label}</label>
                  <NumberInput
                    key={selected + field.key}
                    id={"assumption-" + field.key}
                    size="xs"
                    value={draftValue ?? Number(((inputs[selected][field.key] ?? 0) * field.scale).toFixed(3))}
                    error={
                      invalidInput
                        ? `${t("请输入", "Enter a value between ")}${field.min} – ${field.max}${field.suffix}`
                        : undefined
                    }
                    onChange={(v) => {
                      setDraftValue(v);
                      const value = numeric(v);
                      setInvalidInput(value == null || value < field.min || value > field.max);
                      if (value != null && value >= field.min && value <= field.max) {
                        if (p) drafting.decide(p, "edited");
                        setInputs((previous) => ({
                          ...previous,
                          [selected]: {
                            ...previous[selected],
                            [field.key]: value / field.scale,
                          },
                        }));
                        if (field.key === "revenueCagr")
                          setReferences((v) => v.filter((r) => r.scenario !== selected));
                      }
                    }}
                    min={field.min}
                    max={field.max}
                    step={field.key === "rampYears" || field.key === "exitFcfMultiple" ? 1 : 0.5}
                    decimalScale={field.key === "rampYears" ? 0 : 2}
                    suffix={field.suffix}
                  />
                </div>
              ) : (
                <button
                  key={field.key}
                  id={"assumption-" + field.key}
                  type="button"
                  onClick={() => {
                    setActiveField(field.key);
                    setDraftValue(null);
                    setInvalidInput(false);
                  }}
                >
                  <span>{field.label}</span>
                  <strong>
                    {number((inputs[selected][field.key] ?? 0) * field.scale, 2)}
                    {field.suffix}
                  </strong>
                </button>
              );
            })}
          </div>
          <details className="mx-model-sources" id="valuation-assumption-sources">
            <summary>{t("参数依据", "Assumption sources")}</summary>
            {draft && <DraftEvidence draft={draft} />}
            <Facts
              rows={fields.map((field) => {
                const ref = references.find((r) => r.scenario === selected);
                const changed = inputs[selected][field.key] !== initial.scenarios[selected].inputs[field.key];
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
          </details>
          <Button
            variant="subtle"
            onClick={() => {
              setDraftValue(null);
              setInvalidInput(false);
              drafting.reset();
              setEditingProposal(null);
              setInputs(Object.fromEntries(keys.map((k) => [k, initial.scenarios[k].inputs])));
              setReferences(initial.references ?? []);
            }}
          >
            {t("重置假设", "Reset assumptions")}
          </Button>
          <Button
            fullWidth
            onClick={() => setSaveOpen(true)}
            loading={save.isPending}
            disabled={busy || query.isError || saved || staleDraft || Boolean(drafting.phase)}
          >
            {saved ? t("已保存", "Saved") : t("保存模型版本", "Save model version")}
          </Button>
          {save.isError && !staleDraft && <p role="alert">{t("保存失败，请重试。", "Could not save. Try again.")}</p>}
      {referencePanel && createPortal(<>
        <Panel
          title={t("经营参考", "Operating reference")}
          action={
            <span className="mx-unit">
              {statementPeriod(result, data, t)}
            </span>
          }
          help={methodology}
        >
          <div className="mx-metric-grid">
            {residual ? <Metric label={t("普通股净利润", "Common earnings")} value={compact(result.basis.commonEarnings, locale)} /> :
              <Metric label={t("营收", "Revenue")} value={compact(result.basis.revenue, locale)} />}
            <Metric
              label={residual ? t("每股净资产", "Book value per share") : marginLabel}
              value={
                residual
                  ? currency(result.basis.bookPerShare, result.basis.currency, 2)
                  : percent(result.basis.startMargin, false, 2)
              }
            />
          </div>
          <details className="mx-chart-data">
            <summary>{t("基数与资本结构", "Basis & capital structure")}</summary>
            <Facts
              rows={[
                [
                  t("报表 → 报价", "Reporting → quote"),
                  `${result.basis.reportingCurrency ?? result.basis.currency} → ${result.basis.currency} · ${result.basis.fxRate ?? "—"}`,
                ],
                ...(result.basis.ordinaryPerReceipt
                  ? ([
                      [
                        t("每份存托凭证对应普通股", "Ordinary shares per receipt"),
                        String(result.basis.ordinaryPerReceipt),
                      ],
                    ] as [string, string][])
                  : []),
                [t("模型股数", "Model share count"), number(result.basis.shares, 0)],
                [
                  t("现金及短期投资", "Cash & short-term investments"),
                  compact(latestFact("cash"), locale) + " " + (data.financialFacts?.currency ?? ""),
                ],
                [
                  t("总债务", "Total debt"),
                  compact(latestFact("debt"), locale) + " " + (data.financialFacts?.currency ?? ""),
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
        {!residual && <GrowthContext data={data} analyst={analyst} />}
      </>, referencePanel)}
      <Modal
        opened={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={t("保存模型版本", "Save model version")}
      >
        <Facts
          rows={[
            [t("预测年限", "Horizon"), `${horizon}Y`],
            [scenarioNames[selected], currency(current.value, result.basis.currency, 2)],
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
            onClick={() => save.mutate({ ...liveRequest, reason, draftReview: draft?.review })}
            loading={save.isPending}
            disabled={busy || query.isError || staleDraft || Boolean(drafting.phase)}
          >
            {t("保存版本", "Save version")}
          </Button>
        </Group>
        {reReview}
        {save.isError && !staleDraft && <p role="alert">{t("保存失败，请重试。", "Could not save. Try again.")}</p>}
      </Modal>
    </>
  );
}

function ModelDetails({ result }: { result: Preview }) {
  const t = useCopy();
  const [worksheet, setWorksheet] = useState("base");
  return <>
    <div id="research-sensitivity"><ValuationSensitivity result={result} /></div>
    <div id="research-worksheet"><ValuationWorksheet result={result}
      projection={result.scenarios[worksheet] ?? result.scenarios.base}
      worksheet={worksheet} onWorksheet={setWorksheet}
      scenarioNames={{ bear: t("保守", "Bear"), base: t("中性", "Base"), bull: t("乐观", "Bull") }} /></div>
  </>;
}
