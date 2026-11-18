"use client";

import { LockSimple, X } from "@phosphor-icons/react";
import type { components } from "@/lib/api-schema";
import { useLocale, type Locale } from "@/components/locale-provider";
import { formatCalendarDate, formatReadingTime, localeTag } from "@/ui/formatters";
import { ApiError, compact, number } from "./data";
import { periodText } from "./evidence-notices";
import { Facts, Help, Pending, QueryError, Tag, useCopy } from "./foundation";
import { quoteValue } from "./financial-values";
import { MINUS, readingTone } from "./reading-format";
import type { Maintenance } from "./valuation-queries";

type Copy = (zh: string, en: string) => string;
type Walk = components["schemas"]["ScenarioWalk"];
type Row = { label: string; value: (walk: Walk) => number | null | undefined; kind: "value" | "change" | "sub" | "total" };
export type InputField = components["schemas"]["LockedInput"]["field"];

const keys = ["bear", "base", "bull"] as const;
const scenarioNames = { bear: ["保守", "Bear"], base: ["中性", "Base"], bull: ["乐观", "Bull"] } as const;

/** A change in the quote currency: +US$9.40, −US$0.90 or US$0.00. */
export function signedValue(value: number | null | undefined, currency: string) {
  if (value == null) return "—";
  const tone = readingTone(value, 2);
  const amount = quoteValue(tone ? Math.abs(value) : 0, currency);
  return tone === "up" ? "+" + amount : tone === "down" ? MINUS + amount : amount;
}

function figureName(metric: string, family: Maintenance["family"], t: Copy) {
  const names: Record<string, [string, string]> = {
    revenue: ["营收", "Revenue"],
    startMargin: family === "net-income" ? ["净利率", "Net margin"] : ["现金流率", "FCF margin"],
    freeCashflow: ["自由现金流", "Free cash flow"],
    earnings: family === "residual-income" ? ["普通股净利润", "Common earnings"] : ["净利润", "Net income"],
    netIncome: ["净利润", "Net income"],
    commonIncome: ["普通股净利润", "Common earnings"],
    cash: ["现金及短期投资", "Cash & short-term investments"],
    commonEquity: ["普通股净资产", "Common equity"],
    listingShares: ["模型股数", "Model share count"],
    ordinaryShares: ["期末股数", "Period-end shares"],
    operatingCashflow: ["经营现金流", "Operating cash flow"],
    capex: ["资本开支", "Capital expenditure"],
  };
  const [zh, en] = names[metric] ?? [metric, metric];
  return t(zh, en);
}

type Figure = number | null | undefined;

/** The compact unit the reader's locale uses for a magnitude: K, m, bn; 万, 亿. */
function compactUnit(value: number, locale: Locale) {
  const parts = new Intl.NumberFormat(localeTag(locale), { notation: "compact", maximumFractionDigits: 6 })
    .formatToParts(Math.abs(value));
  const mantissa = Number(parts.filter((p) => ["integer", "decimal", "fraction"].includes(p.type))
    .map((p) => p.type === "decimal" ? "." : p.value).join(""));
  const scale = mantissa ? 10 ** Math.round(Math.log10(Math.abs(value) / mantissa)) : 1;
  return { scale, unit: parts.filter((p) => p.type === "compact").map((p) => p.value).join("") };
}

/**
 * Two figures of one quantity in one unit, with the decimals that show their
 * difference to about two significant digits: a restatement from 391.035bn to
 * 390.912bn reads 391.04bn → 390.91bn, never 391bn → 391bn.
 */
export function distinct(first: Figure, second: Figure, unit: string, locale: Locale): [string, string] {
  if (first == null || second == null) return [compact(first, locale), compact(second, locale)];
  const ratio = unit === "ratio";
  const { scale, unit: suffix } = ratio ? { scale: 0.01, unit: "%" } : compactUnit(Math.max(Math.abs(first), Math.abs(second)), locale);
  const gap = Math.abs(first - second) / scale;
  const digits = gap > 0 ? Math.min(4, Math.max(ratio ? 1 : 0, Math.ceil(Math.log10(10 / gap)))) : 1;
  const format = new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const text = (value: number) => (value < 0 ? MINUS : "") + format.format(Math.abs(value) / scale) + suffix;
  return [text(first), text(second)];
}

function unitOf(unit: string, currency: string | null | undefined) {
  return unit === "currency" && currency ? " " + currency : "";
}

/** A figure before and after: 4,000 → 3,850 USD. */
export function pair(before: Figure, after: Figure, unit: string, currency: string | null | undefined, locale: Locale) {
  const [a, b] = distinct(before, after, unit, locale);
  return a + " → " + b + unitOf(unit, currency);
}

function conflictText(conflict: Maintenance["conflicts"][number], t: Copy, locale: Locale) {
  if (conflict.kind !== "quarters-vs-fiscal-year") return t("两行数字不同", "two different rows");
  const [quarters, year] = distinct(conflict.quarters, conflict.fiscalYear, conflict.unit, locale);
  return t("四季合计 ", "four quarters ") + quarters + t(" · 年报 ", " · fiscal year ") + year +
    unitOf(conflict.unit, conflict.currency);
}

/** "Free cash flow" → "free cash flow" inside an English sentence; acronyms stay. */
function inSentence(name: string) {
  return /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
}

type GapReview = Pick<Maintenance, "restatementCheck" | "restatementGap" | "uncheckedFigures" | "family" | "saved" | "current">;

/** Why the saved period, or some of its figures, could not be checked for restatements. */
export function restatementGapText(review: GapReview, t: Copy, locale: Locale) {
  const gap = review.restatementGap;
  if (gap === "currency-changed") {
    const from = review.saved.reportingCurrency ?? "—", to = review.current.reportingCurrency ?? "—";
    return locale === "zh" ? `报表币种已从 ${from} 改为 ${to}，无法核对重述。`
      : `The statements now report in ${to} rather than ${from}, so restatements cannot be checked.`;
  }
  const names = (review.uncheckedFigures ?? []).map((metric) => figureName(metric, review.family, t));
  if (gap === "metrics-incomplete" && names.length) {
    const list = locale === "zh" ? names.join("、")
      : new Intl.ListFormat("en-GB", { type: "conjunction" }).format(names.map(inSentence));
    if (review.restatementCheck === "restated") return locale === "zh"
      ? `最新报表缺少这一期的${list}，重述的合计影响无法计算。`
      : `The current statements lack this period's ${list}, so the combined effect of the restatement cannot be computed.`;
    return locale === "zh" ? `最新报表缺少这一期的${list}，无法核对是否重述。`
      : `The current statements lack this period's ${list}, so ${names.length > 1 ? "they" : "it"} cannot be checked for restatement.`;
  }
  if (gap === "metrics-incomplete") return t("最新报表缺少这一期的数字，无法核对重述。",
    "The current statements lack this period's figures, so restatements cannot be checked.");
  if (gap === "period-missing") return t("保存时的期间已不在当前报表中，无法核对重述。",
    "The saved period is no longer in the current statements, so restatements cannot be checked.");
  return null;
}

export function EvidenceReview({ review, error, pending, retry, selected, currency, describe, close }: {
  review?: Maintenance;
  error: unknown;
  pending: boolean;
  retry: () => void;
  selected: string;
  currency: string;
  describe: (field: InputField, value: number | null | undefined) => { label: string; text: string };
  close: () => void;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const heading = <div className="mx-evidence-heading">
    <h3 id="valuation-evidence-title">{t("新证据", "New evidence")}</h3>
    <Help label={t("新证据", "New evidence")} basis={t(
      "报表、预期和价格来自当前研究数据，同一上市线持有时用券商价。EPS 一致预期的变化来自本地预期记录。",
      "Statements, estimates and prices come from the current research data; a held listing uses the broker price. EPS consensus changes come from the local estimate record.",
    )}>
      <p>{t(
        "从保存的版本出发依次替换：先换成最新报表，价格和汇率仍按保存时；再换成现在的价格和汇率；最后换成新的假设。各部分相加等于新提案，每个数都由估值引擎算出。",
        "Starting from the saved version, each step replaces one part: first the latest statements at the saved price and exchange rate, then the current price and rate, then the new assumptions. The parts add up to the new proposal, and the valuation engine computes every figure.",
      )}</p>
      <p>{t(
        "重述是保存时用的那一期数字在最新报表里变了，它的影响单独列出，计入新财务基数。冲突是两处来源对同一个数说法不一，模型不会把两者混在一起。锁定的假设不会被改动。",
        "A restatement is a change to a figure of the period the saved version used; its effect is shown separately and included in the new financial base. A conflict is two sources disagreeing about one figure, and the model never blends them. Locked assumptions are never changed.",
      )}</p>
    </Help>
    <button type="button" className="mx-evidence-close" aria-label={t("收起新证据", "Close new evidence")} onClick={close}>
      <X size={14} aria-hidden="true" />
    </button>
  </div>;
  if (!review) {
    const code = error instanceof ApiError ? error.message : null;
    return <section id="valuation-evidence" className="mx-evidence" tabIndex={-1} aria-labelledby="valuation-evidence-title" aria-busy={pending}>
      {heading}
      {pending ? <Pending compact height={196} label={t("正在比较保存的版本…", "Comparing with the saved version…")} />
        : code === "valuation-currency-changed" ? <p role="alert" className="mx-evidence-empty">
          {t("报价币种已改变，无法与保存的版本比较。", "The quote currency changed, so the saved version cannot be compared.")}</p>
        : error ? <QueryError error={error} retry={retry} /> : null}
    </section>;
  }
  const restated = keys.some((key) => review.scenarios[key]?.restatementEffect != null);
  const savedDay = formatReadingTime(review.savedAt, locale, timeZone, "day");
  const rows: Row[] = [
    { label: locale === "zh" ? `${savedDay} 保存` : `Saved ${savedDay}`, value: (w) => w.saved, kind: "value" },
    { label: t("新财务基数", "New financial base"), value: (w) => w.statementsEffect, kind: "change" },
    ...(restated ? [{ label: t("其中重述", "Of which restated"), value: (w: Walk) => w.restatementEffect, kind: "sub" } as Row] : []),
    { label: t("价格与汇率", "Price and FX"), value: (w) => w.priceFxEffect, kind: "change" },
    { label: t("改动的假设", "Changed assumptions"), value: (w) => w.assumptionsEffect, kind: "change" },
    { label: t("新提案", "New proposal"), value: (w) => w.proposal, kind: "total" },
  ];
  const name = (scenario: keyof typeof scenarioNames) => {
    const [zh, en] = scenarioNames[scenario];
    return t(zh, en);
  };
  const reporting = review.current.reportingCurrency;
  const details: [string, string][] = [
    [t("期间", "Period"), review.saved.periodId === review.current.periodId
      ? periodText(review.current.periodId, locale)
      : periodText(review.saved.periodId, locale) + " → " + periodText(review.current.periodId, locale)],
    ...review.figures.map((f): [string, string] => [figureName(f.metric, review.family, t),
      pair(f.saved, f.current, f.unit, f.currency, locale)]),
    [t("现价", "Price"), quoteValue(review.saved.spot, currency) + " → " + quoteValue(review.current.spot, currency) +
      (review.saved.spotSource !== review.current.spotSource || review.current.spotSource === "broker"
        ? " · " + [review.saved.spotSource, review.current.spotSource].map((s) => s === "broker" ? t("券商", "Broker") : t("行情", "Quote")).join(" → ")
        : "")],
    ...(reporting && (reporting !== currency || (review.saved.reportingCurrency != null &&
      review.saved.reportingCurrency !== reporting)) ? [[t("汇率", "Exchange rate"),
      review.fxSeparated
        ? reporting + " → " + currency + " " + number(review.saved.fxRate, 5) + " → " + number(review.current.fxRate, 5)
        : (review.saved.reportingCurrency ?? "—") + " → " + reporting + t("，汇率随报表一起计入新财务基数", "; the rate moves with the statements")] as [string, string]] : []),
    ...review.assumptions.map((a): [string, string] => {
      const before = describe(a.field, a.saved), after = describe(a.field, a.proposed);
      return [name(a.scenario) + " · " + before.label, before.text + " → " + after.text + (a.locked ? t("（已锁定）", " (locked)") : "")];
    }),
    ...(review.lockedInputs.length ? [[t("锁定的假设", "Locked assumptions"), review.lockedInputs
      .map((lock) => name(lock.scenario) + " · " + describe(lock.field, null).label).join(t("、", ", "))] as [string, string]] : []),
  ];
  return <section id="valuation-evidence" className="mx-evidence" tabIndex={-1} aria-labelledby="valuation-evidence-title" aria-busy={pending}>
    {heading}
    <div className="mx-table-scroll" tabIndex={0} role="region" aria-label={t("情景价值的变化", "Change in scenario values")}>
      <table className="mx-evidence-walk">
        <thead><tr>
          <td />
          {keys.map((key) => <th scope="col" key={key} data-selected={selected === key || undefined}>{name(key)}</th>)}
        </tr></thead>
        <tbody>{rows.map(({ label, value, kind }) => <tr key={label} data-kind={kind}>
          <th scope="row">{label}</th>
          {keys.map((key) => {
            const walk = review.scenarios[key];
            const figure = walk ? value(walk) : null;
            return <td key={key} data-selected={selected === key || undefined}>
              {kind === "value" || kind === "total" ? quoteValue(figure, currency) : signedValue(figure, currency)}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <ul className="mx-evidence-notes">
      {review.restatements.map((r) => <li key={"r" + r.periodId + r.metric}>
        <Help label={t("重述", "Restated")} tag={<Tag tone="warn">{t("重述", "Restated")}</Tag>}>
          <p>{restated ? t("保存时用的这一期数字在最新报表里变了。它对估值的影响单独列在「其中重述」，计入新财务基数。",
            "The latest statements report this figure of the saved period differently. Its effect on the values is listed under Of which restated and included in the new financial base.")
            : t("保存时用的这一期数字在最新报表里变了，计入新财务基数。",
              "The latest statements report this figure of the saved period differently; it is included in the new financial base.")}</p>
        </Help>
        <span>{periodText(r.periodId, locale)} · {figureName(r.metric, review.family, t)} {pair(r.saved, r.current, r.unit, r.currency, locale)}</span>
      </li>)}
      {review.conflicts.map((c) => <li key={"c" + c.kind + c.periodId + c.metric}>
        <Help label={t("冲突", "Conflict")} tag={<Tag tone="warn">{t("冲突", "Conflict")}</Tag>}>
          <p>{c.kind === "quarters-vs-fiscal-year"
            ? t("四个季度的合计与同一天结束的年报相差超过 0.5%。模型用四个季度的合计，不把两者混合。",
              "The four quarters and the fiscal year ending on the same day differ by more than 0.5%. The model uses the four quarters and never blends the two.")
            : c.blocksComparison
            ? t("数据源对这一财年给出了两行不同的数字，无法用它核对四个季度的合计。",
              "The source reports two different rows for this fiscal year, so the four quarters cannot be checked against it.")
            : t("数据源对这一期给出了两行不同的数字，这一期不进入模型。",
              "The source reports two different rows for this period, so the model does not use it.")}</p>
        </Help>
        <span>{periodText(c.periodId, locale)} · {figureName(c.metric, review.family, t)} {conflictText(c, t, locale)}</span>
      </li>)}
      {review.estimates.map((e) => <li key={"e" + e.metric + e.periodEnd}>
        <Tag>{t("预期", "Estimates")}</Tag>
        <span>{e.metric === "consensusEps" ? t("EPS 一致预期", "EPS consensus") : t("营收增长一致预期", "Revenue-growth consensus")}
          {" · "}{t("财年 ", "FY ") + formatCalendarDate(e.periodEnd, locale)}{" · "}
          {pair(e.saved, e.current, e.metric === "consensusEps" ? "currency" : "ratio", e.currency, locale)}</span>
      </li>)}
      {review.restatementGap && <li className="mx-evidence-muted">{restatementGapText(review, t, locale)}</li>}
    </ul>
    <details className="mx-evidence-detail">
      <summary>{t("明细", "Details")}</summary>
      <Facts rows={details.map(([label, value]) => [label, label === t("锁定的假设", "Locked assumptions")
        ? <span className="mx-evidence-locks"><LockSimple size={12} aria-hidden="true" />{value}</span> : value])} />
    </details>
  </section>;
}
