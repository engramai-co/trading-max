"use client";

import { Check, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { components } from "@/lib/api-schema";
import { useLocale, type Locale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { assistantSettingsKey, DISCLOSURE_REVISION } from "./assistant-settings";
import { metricNames } from "./research-facts";
import { api, jsonRequest, number } from "./data";
import { useCopy } from "./foundation";
import type { Preview, ScenarioInput } from "./research-facts";
import { draftBlockMessage, inputKey, newReview, readDraft, type Decision, type DraftEvent, type DraftState, type Proposal } from "./valuation-draft";

export function useDraftPreferences() {
  const prefs = useQuery({
    queryKey: assistantSettingsKey,
    queryFn: ({ signal }) => api<components["schemas"]["AssistantSettingsResponse"]>("/settings/assistant", { signal }),
    retry: false,
  }).data;
  const enabled = Boolean(prefs?.enabled && prefs.consentRevision >= DISCLOSURE_REVISION && prefs.acceptedConsentRevision === prefs.consentRevision);
  return {enabled, revision: prefs?.revision};
}

export function useValuationDraft(initial: Preview, requestedFamily: Preview["basis"]["family"] | undefined,
  horizon: number, inputs: Record<string, ScenarioInput>, publication: string | null | undefined,
  prefs: ReturnType<typeof useDraftPreferences>, currentBasis: string | null) {
  const {enabled} = prefs;
  const basis = JSON.stringify([initial.id, horizon, requestedFamily]);
  const runKey = JSON.stringify([basis, publication, currentBasis, inputs, enabled, prefs.revision]);
  const controller = useRef<AbortController | null>(null);
  const [run, setRun] = useState<{ key: string; phase: DraftEvent["phase"] } | null>(null);
  const [failure, setFailure] = useState<{key: string; code: string} | null>(null);
  const error = failure?.key === runKey ? failure.code : null;
  const [draft, setDraft] = useState<DraftState | null>(null);
  useLayoutEffect(() => () => controller.current?.abort(), [runKey]);
  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setRun(null);
  };
  async function start(before: Preview) {
    if (draft || !enabled || controller.current && !controller.current.signal.aborted) return;
    const request = new AbortController();
    controller.current = request;
    setFailure(null);
    setRun({ key: runKey, phase: "preparing" });
    try {
      const response = await fetch(`/api/backend/research/${encodeURIComponent(initial.basis.ticker)}/valuation-draft`, {
        ...jsonRequest("POST", { previewId: initial.id, horizon, requestedFamily, scenarios: inputs }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      });
      const result = await readDraft(response, phase => {
        if (!request.signal.aborted) setRun(current =>
          current?.key === runKey && current.phase === phase ? current : { key: runKey, phase });
      });
      if (request.signal.aborted) return;
      if (result.family !== initial.basis.family || result.familySelection !== (initial.familySelection ?? (requestedFamily ? "override" : "automatic")))
        throw new Error("valuation-draft-review-required");
      setDraft({ result, review: newReview(result), before, basis });
    } catch (e) {
      if (!request.signal.aborted) {
        const code = e instanceof Error && e.name === "TimeoutError" ? "assistant_timeout" :
          e instanceof Error ? e.message : "assistant_failed";
        setFailure({key: runKey, code});
      }
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setRun(null);
      }
    }
  }
  function decide(proposal: Proposal, decision: Decision) {
    setDraft(prev => {
      if (!prev) return prev;
      const { decisions } = prev.review;
      return { ...prev, review: { ...prev.review, decisions: { ...decisions,
        [proposal.scenario]: { ...decisions[proposal.scenario], [proposal.field]: decision },
      } } };
    });
  }
  function reset() {
    cancel();
    setDraft(null);
    setFailure(null);
  }
  return { enabled, draft, error, phase: run?.key === runKey ? run.phase : null,
    stale: Boolean(draft && (draft.basis !== basis || draft.result.snapshotId !== publication)) || error === "valuation-draft-review-required",
    start, cancel, reset, decide };
}

const phases = {
  preparing: ["正在读取估值口径…", "Reading valuation basis…"], basis: ["正在核对报价与股本…", "Checking quote and shares…"],
  operating: ["正在读取报表…", "Reading statements…"], expectations: ["正在核对一致预期…", "Checking consensus…"],
  market: ["正在读取市场参照…", "Reading market references…"], evaluating: ["正在计算情景估值…", "Calculating scenarios…"],
} as const;

export function DraftStatus({ phase, error }: {phase: DraftEvent["phase"] | null; error: string | null}) {
  const t = useCopy();
  if (phase && phase in phases) {
    const [zh,en] = phases[phase as keyof typeof phases];
    return <p className="mx-draft-status" role="status">{t(zh,en)}</p>;
  }
  if (!error || error === "valuation-draft-review-required") return null;
  const message = draftBlockMessage(error, t) ?? (error === "assistant_busy" ? t("已有估值草稿正在生成。", "Another valuation draft is running.")
    : error === "valuation-evidence-unavailable" ? t("缺少可核对的公开报价或报表。", "A verified public quote or statement is missing.")
    : error === "assistant_timeout" || error === "assistant_limit_reached" ? t("本次起草已达用量或时间上限。", "The draft reached its time or usage limit.")
    : error === "valuation-draft-settings-changed" ? t("模型设置已改变，请重新起草。", "Model settings changed. Start a new draft.")
    : t("起草中断，可重新起草。", "Draft interrupted. Try drafting again."));
  return <p className="mx-draft-status" role="alert">{message}</p>;
}

const categories = { consensus: ["一致预期", "Consensus"], reported: ["报告值", "Reported"],
  derived: ["推导", "Derived"], template: ["模板", "Template"], judgment: ["判断", "Judgment"] } as const;
const reasons = {
  "consensus-growth": ["参考下一财年的营收增长预期。", "Uses next fiscal year’s consensus as the growth reference."],
  "statement-growth": ["沿用最近完整期间的营收增速。","Carries forward the latest complete period’s revenue growth."],
  "statement-margin": ["沿用本期报表的利润率。","Carries forward the margin from the bound statements."],
  "common-roe": ["用普通股净利润除以同期普通股净资产。","Divides common earnings by common equity for the same period."],
  "cost-of-equity": ["采用当前股权成本估算。","Uses the published cost-of-equity estimate."],
  "book-multiple": ["参考当前市净率设定退出倍数。","Uses the current price-to-book ratio as the exit reference."],
  "sector-template": ["沿用此情景的板块模板。","Uses the sector template for this scenario."],
  "saved-assumption": ["沿用上次保存的判断。","Carries forward the last saved assumption."],
} as const;

export function ProposalRow({ draft, proposal, label, scale, suffix, decide, edit, disabled }: {
  draft: DraftState; proposal: Proposal; label: string; scale: number; suffix: string; disabled: boolean;
  decide: (decision: "accepted" | "rejected") => void; edit: () => void;
}) {
  const t = useCopy();
  const p = proposal;
  const decision = draft.review.decisions[p.scenario][p.field];
  const old = draft.before.scenarios[p.scenario].inputs[inputKey[p.field]];
  const format = (v: number | null | undefined) => v == null ? "—" : number(v * scale, 3) + suffix;
  const [zh,en] = reasons[p.source], [cz,ce] = categories[p.category];
  return <div className="mx-draft-row" data-decision={decision}>
    <div className="mx-draft-values">
      <button type="button" disabled={disabled} onClick={edit} className="mx-draft-field" aria-label={t("编辑", "Edit") + " " + label}>{label}</button>
      <del><span className="sr-only">{t("原值","Previous value")}</span> {format(old)}</del>
      <span className="mx-draft-candidate"><strong><span className="sr-only">{t("建议值","Proposed value")}</span> {format(p.value)}</strong><small>{t(cz,ce)}</small></span>
      <div className="mx-draft-actions">
        <button type="button" disabled={disabled} aria-label={t("接受", "Accept") + " " + label} aria-pressed={decision === "accepted"} onClick={() => decide("accepted")}><Check aria-hidden /></button>
        <button type="button" disabled={disabled} aria-label={t("拒绝", "Reject") + " " + label} onClick={() => decide("rejected")}><X aria-hidden /></button>
      </div>
    </div>
    <div className="mx-draft-reason">{t(zh,en)}{" "}
      {p.originId && <a href={`#draft-origin-${p.originId}`} onClick={openSources}>{p.source === "sector-template" ? t("模板来源", "Template source") : t("保存的假设", "Saved assumption")}</a>}
      {p.evidenceIds.map(id => {
        const row = draft.result.evidence[id];
        return row && <span className="mx-draft-citation" key={id}>
          <EvidenceFigure row={row} />{" "}
          <a href={`#draft-evidence-${id}`} onClick={openSources}>{sourceWord(row.locator.dataset, t)}</a>
        </span>;
      })}
    </div>
  </div>;
}

function openSources() {
  const details = document.getElementById("valuation-assumption-sources");
  if (details instanceof HTMLDetailsElement) details.open = true;
}

function sourceWord(dataset: unknown, t: (zh: string, en: string) => string) {
  if (dataset === "analyst" || dataset === "pe-archive") return t("分析师","Analysts");
  return dataset === "financials" ? t("财报","Financials") : t("行情","Market");
}

const draftMetricNames: Record<string, [string,string]> = {
  consensusRevenueGrowth: ["营收增长一致预期","Consensus revenue growth"], commonEquity:["普通股净资产","Common equity"],
  costOfEquity:["股权成本","Cost of equity"], priceToBook:["市净率","Price to book"],
  spot:["公开报价","Public quote"], sharesOutstanding:["上市股数","Listing shares"],
  reportingToQuoteFx:["报表至报价币种汇率","Reporting-to-quote exchange rate"],
};

type EvidenceRow = components["schemas"]["EvidenceItem"];
type Copy = (zh: string, en: string) => string;

function evidenceValue(row: EvidenceRow, t: Copy) {
  if (row.value == null) return "—";
  switch (row.unit) {
    case "ratio": return number(row.value * 100, 3) + "%";
    case "ratio-point": return number(row.value * 100, 3) + t(" 个百分点", " pp");
    case "fx": return number(row.value, 5) + ` ${row.counterCurrency}/${row.currency}`;
    case "shares": return number(row.value) + t(" 股", " shares");
    case "multiple": return number(row.value, 3) + "×";
    case "perShare": return number(row.value, 3) + " " + row.currency + t("/股", "/share");
    case "currency": return number(row.value, 3) + " " + row.currency;
  }
}

function metricLabel(metric: EvidenceRow["metric"], locale: Locale) {
  return (metricNames[metric] ?? draftMetricNames[metric] ?? [metric, metric])[locale === "en" ? 1 : 0];
}

function EvidenceFigure({row}: {row: EvidenceRow}) {
  const t = useCopy();
  const {locale, timeZone} = useLocale();
  const periods = {spot: t("时点", "Spot"), ttm: t("过去十二个月", "TTM"), annual: t("财年", "FY"),
    quarterly: t("季度", "Quarter"), semiannual: t("半年", "Half-year"), irregular: t("报告期", "Period"),
    forecast: t("预测期", "Forecast period")};
  const period = [periods[row.period.kind], row.period.end && formatCalendarDate(row.period.end, locale)].filter(Boolean).join(" ");
  return <>{metricLabel(row.metric, locale)} {evidenceValue(row,t)} · {period} · {t("采集于", "Observed")}{" "}
    {row.observedAt ? formatDateTime(row.observedAt, locale, timeZone) : "—"}</>;
}

const scenarioLabels = { bear: ["保守", "Bear"], base: ["中性", "Base"], bull: ["乐观", "Bull"] };
const assumptionLabels = {
  revenue_cagr: ["营收增长","Revenue growth"], target_fcf_margin: ["目标利润率","Target margin"],
  discount_rate: ["股权成本","Cost of equity"], exit_fcf_multiple: ["退出倍数","Exit multiple"],
  share_cagr: ["股数变化","Share change"], ramp_years: ["达到目标的年数","Years to target"],
  initial_roe: ["期初 ROE","Initial ROE"], payout: ["派息率","Payout ratio"], terminal_pb: ["终值市净率","Terminal P/B"],
};
const rate = (v: number | null | undefined) => v == null ? "—" : number(v * 100, 3) + "%";

export function DraftEvidence({ draft }: { draft: DraftState }) {
  const t = useCopy();
  const { locale } = useLocale();
  return <div className="mx-draft-evidence">
    {Object.entries(draft.result.origins).map(([id, origin]) =>
      <div id={`draft-origin-${id}`} key={id} tabIndex={-1}>
        {origin.source === "sector-template" ? <>
          <strong>{t("板块模板", "Sector template")} · {origin.inputs.profile}</strong>
          <span>{t("历史营收增长", "Historical revenue growth")} {rate(origin.inputs.annualRevenueGrowth)}
            {" · "}{t("增长上限", "Growth cap")} {rate(origin.inputs.growthCap)}</span>
          <span>{t("期初利润率", "Starting margin")} {rate(origin.inputs.basis.startMargin)}
            {" · "}{t("利润率上限", "Margin cap")} {rate(origin.inputs.marginCap)}</span>
          <span>{t("股权成本", "Cost of equity")} {rate(origin.inputs.effectiveDiscountRate)}
            {" · "}{t("退出倍数", "Exit multiple")} {number(origin.inputs.exitMultiple)}×
            {" · "}{t("股数变化", "Share change")} {rate(origin.inputs.shareCagr)}</span>
          <span>{origin.evidenceIds.map((key, i) => <span key={key}>{i > 0 && " · "}<a href={`#draft-evidence-${key}`}>
            {metricLabel(draft.result.evidence[key].metric, locale)}</a></span>)}</span>
        </> : <strong>{origin.modelId ? t("保存的模型", "Saved model") + " · " + origin.modelId : t("已配置的假设", "Configured assumptions")}</strong>}
        {draft.result.proposals.filter(p => p.originId === id).map(p => <span key={p.scenario + p.field}>
          {scenarioLabels[p.scenario][locale === "en" ? 1 : 0]} · {assumptionLabels[p.field][locale === "en" ? 1 : 0]}
          {" "}{p.field === "ramp_years" ? number(p.value) : p.field === "terminal_pb" || p.field === "exit_fcf_multiple"
            ? number(p.value) + "×" : rate(p.value)}
        </span>)}
      </div>)}
    {Object.entries(draft.result.evidence).map(([id, row]) => {
    const view = row.locator.dataset === "analyst" || row.locator.dataset === "pe-archive" ? "analyst" :
      row.locator.dataset === "financials" ? "fundamentals" : "valuation";
    return <div id={`draft-evidence-${id}`} key={id} tabIndex={-1}>
      <strong><EvidenceFigure row={row} /></strong>
      <a href={`/research?ticker=${encodeURIComponent(draft.before.basis.ticker)}&view=${view}`} target="_blank" rel="noreferrer">{sourceWord(row.locator.dataset, t)} ↗</a>
    </div>;
  })}</div>;
}
