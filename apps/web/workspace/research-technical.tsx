"use client";

// THESIS: a daily state diagnosis explains the chart, not a trading instruction.
// OWN-WORLD: existing blue/white tokens, tabular scores, quiet divided rows.
// STORY: overview entry → same ticker's chart → expandable scoring evidence.
// FIRST VIEWPORT: score rail left; independently loaded chart and diagnosis right.
// FORM: approved overview entry and merged 分项诊断 comps, 2026-10-06.
// FINISH: bounded desktop/mobile comparison, fresh finish review, local surface record.
import type { ResearchLensSnapshot, TechnicalScoreSummary } from "@/lib/types";
import { ArrowRight, CaretDown, CaretRight, Minus, TrendDown, TrendUp } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatDate } from "@/ui/formatters";
import { number, percent } from "./data";
import { Empty, Help, Panel, Pending, QueryError, useCopy } from "./foundation";
import { PriceHistory } from "./research-price";
import { TechnicalView } from "./research-company";
import { useRouteState } from "./route-state";
import { factorMeaning, impactTone, isLatestSession, stateName, technicalGroups } from "./technical-diagnosis";

export function TechnicalScoreCard({ data, compact = false, pending = false }: {
  data?: TechnicalScoreSummary | null; compact?: boolean; pending?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { update } = useRouteState("push");
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const score = data?.score;
  const valid = score != null && Number.isFinite(score) && score >= 0 && score <= 100;
  const scoreTone = valid ? score < 45 ? "mx-down" : score >= 56 ? "mx-up" : "" : "";
  const breakdown = data?.scoreBreakdown;
  const title = t("技术状态", "Technical state");
  return <div className={`mx-tech-score ${compact ? "mx-tech-score-compact" : ""}`}>
    <div className="mx-tech-heading"><h2>{compact
      // On the overview the title opens the full diagnosis.
      ? <button type="button" className="mx-ranking-link" onClick={() => update({ view: "technical", technicalView: "data" })}>{title}<ArrowRight size={14} aria-hidden="true" /></button>
      : title}</h2>
      <Help label={title}>
        <p>{t("50 分为中性起点，现有日线规则按趋势、动量、相对表现与量能加减分，最终限制在 0–100。波动风险单独展示；分数不是上涨概率，也不是买卖建议。", "The existing daily-bar rules start at 50, then add trend, momentum, relative-performance and volume contributions, capped at 0–100. Volatility is separate. This is not an upside probability or a trade recommendation.")}</p>
        <p>{t("评分使用其标注日期的日线，不随图表的历史拖动或粒度选择而改变。", "The score uses daily bars as of its own date, independent of chart navigation and interval.")}</p>
        {breakdown && <p>{t("可用评分依据", "Available scoring inputs")} {breakdown.availableSignals}/{breakdown.totalSignals} · {t("缺失项不计分", "Missing inputs add no points")}</p>}
      </Help>
    </div>
    {/* The latest session is the normal state; an older score names its date. */}
    {data?.asOf && !isLatestSession(data.asOf, today) && <time className="mx-tech-asof" dateTime={data.asOf}>{formatDate(data.asOf, locale, { ...(data.asOf.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }), month: "short", day: "numeric", timeZone: "UTC" })}</time>}
    {pending && !data ? <Pending /> : <>
      <div className={`mx-tech-number ${scoreTone}`}><strong>{valid ? number(score, 0) : "—"}</strong>{valid && <span>/ 100</span>}</div>
      <p className={`mx-tech-state ${scoreTone}`}>{data && valid ? stateName(data, t) : t("暂无技术评分", "Technical score unavailable")}</p>
      {!compact && valid && <div className={`mx-tech-scale ${scoreTone}`} aria-hidden="true"><progress max={100} value={score} /><div><span>0</span><span>100</span></div></div>}
      {data && valid && !breakdown && <p className="mx-tech-status">{data.scoreExplanationState === "mismatch"
        ? t("评分依据暂不可核对", "Score inputs cannot be reconciled") : t("评分依据尚未就绪", "Score inputs unavailable")}</p>}
      {breakdown && breakdown.availableSignals < breakdown.totalSignals && <span className="mx-tech-coverage">{t("部分依据", "Partial inputs")} · {breakdown.availableSignals}/{breakdown.totalSignals}</span>}
      {!compact && data && <div className="mx-tech-risk"><div className="mx-tech-heading"><h3>{t("波动风险", "Volatility")}</h3><Help label={t("波动风险", "Volatility")}>
        {t("ATR / 价格描述日线波动幅度，布林带宽度描述价格分散程度；两者不参与方向评分。", "ATR / price describes daily volatility and Bollinger bandwidth describes dispersion. Neither contributes to the directional score.")}
      </Help></div><dl><div><dt>ATR / {t("价格", "price")}</dt><dd>{percent(data.atrPct)}</dd></div><div><dt>{t("布林带宽度", "Bollinger bandwidth")}</dt><dd>{percent(data.bollingerWidth)}</dd></div></dl></div>}
    </>}
  </div>;
}

function TechnicalDiagnosis({ data }: { data: ResearchLensSnapshot }) {
  const t = useCopy();
  const [opened, setOpened] = useState<string | null>("trend");
  const tech = data.technical;
  const breakdown = tech?.scoreBreakdown;
  if (!tech) return <Panel><Empty title={t("技术诊断尚未就绪", "Technical diagnosis unavailable")} /></Panel>;
  return <div id="technical-diagnosis" tabIndex={-1}><Panel className="mx-tech-diagnosis" title={t("技术诊断", "Technical diagnosis")}
    help={t("每组右侧的数字是它对总分的影响：现有评分规则实际加减的分数，不是四个独立的百分制评分。缺失读数不参与评分；原始指标仍可展开查看。", "The number beside each group is its contribution to the total score: the points the existing scoring rules actually add or subtract, not four independent /100 scores. Missing readings add no points; original metrics remain available below.")}>
    {breakdown ? <div>{breakdown.groups.map((g) => {
      const open = opened === g.key;
      const id = `technical-factor-${g.key}`;
      const summary = g.factors.filter((f) => f.contribution != null && f.contribution !== 0)
        .sort((a, b) => Math.abs(b.contribution!) - Math.abs(a.contribution!))[0];
      return <section key={g.key} className="mx-tech-group" data-open={open}>
        {/* Accordion pattern: the heading holds the button, never the other way round. */}
        <h3 className="mx-tech-group-heading"><button type="button" className="mx-tech-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpened(open ? null : g.key)}>
          <div><span className="mx-tech-group-name">{t(...technicalGroups[g.key])}</span>
            {!open && summary && <span className="mx-tech-reason">{factorMeaning(summary, t)}</span>}</div>
          <strong className={impactTone(g.contribution)}>{g.contribution == null ? "—" : `${g.contribution > 0 ? "+" : ""}${g.contribution}`}</strong>
          {open ? <CaretDown size={18} /> : <CaretRight size={18} />}
        </button></h3>
        <div id={id} hidden={!open} className="mx-tech-evidence">{g.factors.map((f) => <div key={f.key}>
          <span>{factorMeaning(f, t)}</span><span className={impactTone(f.contribution)}>
            {f.contribution == null ? "—" : f.contribution > 0 ? <TrendUp size={15} /> : f.contribution < 0 ? <TrendDown size={15} /> : <Minus size={15} />}
            {f.contribution == null ? t("缺失", "Missing") : `${f.contribution > 0 ? "+" : ""}${f.contribution}`}
          </span>
        </div>)}</div>
      </section>;
    })}<details className="mx-details"><summary>{t("评分合计", "Score accounting")}</summary>
      <p>{t("中性起点", "Neutral base")} {breakdown.baseScore} + {t("分项净影响", "Net contributions")} {breakdown.rawScore - breakdown.baseScore} = {breakdown.rawScore}</p>
      {breakdown.clampAdjustment !== 0 && <p>{t("0–100 边界调整", "0–100 boundary adjustment")} {breakdown.clampAdjustment > 0 ? "+" : ""}{breakdown.clampAdjustment} → {breakdown.score}</p>}
    </details></div> : <Empty title={tech.scoreExplanationState === "mismatch" ? t("评分依据暂不可核对", "Score inputs cannot be reconciled") : t("评分依据尚未就绪", "Score inputs unavailable")} />}
    <details className="mx-details"><summary>{t("原始指标", "Original readings")}</summary><TechnicalView data={data} embedded /></details>
  </Panel></div>;
}

export function TechnicalWorkspace({ ticker, runId, data, fund = false, pending, error, retry }: {
  ticker: string; runId: string; data?: ResearchLensSnapshot; fund?: boolean; pending: boolean; error: boolean; retry: () => void;
}) {
  const { params } = useRouteState("push");
  const focused = useRef(false);
  const focusDiagnosis = params.get("technicalView") === "data";
  useEffect(() => {
    if (focusDiagnosis && data && !focused.current) {
      const target = document.getElementById("technical-diagnosis");
      target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
      focused.current = true;
    }
    if (!focusDiagnosis) focused.current = false;
  }, [data, focusDiagnosis]);
  if (fund) return <div className="mx-tech-main">
    <PriceHistory ticker={ticker} runId={runId} technical compactChart context={data} />
    {data ? <TechnicalView data={data} /> : <Panel>{error ? <QueryError retry={retry} /> : <Pending />}</Panel>}
  </div>;
  return <div className="mx-tech-workspace">
    <Panel className="mx-tech-rail"><TechnicalScoreCard data={data?.technical} pending={pending} />{error && !data && <QueryError retry={retry} />}</Panel>
    <div className="mx-tech-main"><PriceHistory ticker={ticker} runId={runId} technical compactChart context={data} />
      {data ? <TechnicalDiagnosis data={data} /> : <Panel>{error ? <QueryError retry={retry} /> : pending ? <Pending /> : <Empty title="—" />}</Panel>}
    </div>
  </div>;
}
