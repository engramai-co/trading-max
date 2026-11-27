"use client";
import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { compact, currency, object, objects, percent, safeUrl, str } from "@/workspace/data";
import { nextEarningsDate } from "./analyst-data";
import { useAssistant } from "./assistant/context";
import { PageInspection } from "./assistant/inspection-entry";
import { profileSentences, sentenceId } from "./company-profile";
import { industryName } from "./exposure-names";
import { Bento, Facts, Metric, Panel, useCopy } from "./foundation";
import Link from "./link";
import { factIndex, metricNames } from "./research-facts";
import { filingTitle } from "./research-filings";
import { useRouteState } from "./route-state";
import { isImeComposing } from "./shortcut-platform";

/** First two period-delimited sentences of a business description for the collapsed overview card. */
export function businessExcerpt(summary: string): string {
  const breakAt = /\.\s+(?=[A-Z])/g;
  const first = breakAt.exec(summary);
  if (!first) return summary;
  const second = breakAt.exec(summary);
  const secondEnd = second ? second.index + 1 : summary.length;
  return `${summary.slice(0, first.index + 1)} ${summary.slice(first.index + first[0].length, secondEnd)}`;
}

/** A panel title that opens the lens holding its detail. */
function LensTitle({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button type="button" className="mx-ranking-link" onClick={onOpen}>
      {label}
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

/** The description sentence a MaxAI citation names, when this page shows that company. */
function useProfileCitation(summary: string, ticker: string) {
  const { params } = useRouteState();
  const cited = params.get("evidence") === "company_profile"
    && (params.get("ticker") ?? ticker).toUpperCase() === ticker.toUpperCase();
  const id = params.get("sentenceId");
  const position = Number(params.get("sentence"));
  const sentences = useMemo(() => profileSentences(summary), [summary]);
  const index = !cited || !id ? -1
    : sentenceId(sentences[position] ?? "") === id ? position
    : sentences.findIndex((sentence) => sentenceId(sentence) === id);
  return {
    sentences,
    index,
    // A citation without a sentence identity opens the whole description.
    reveal: cited && Boolean(summary) && (!id || index >= 0),
    missing: cited && (!summary || (Boolean(id) && index < 0)),
    key: cited ? [ticker, id, params.get("sentence"), params.get("snapshotId")].join(":") : "",
  };
}

export function CompanyOverview({
  data,
  context,
  gics,
}: {
  data: ResearchLensSnapshot;
  context?: ResearchLensSnapshot;
  gics?: ResearchShell["instruments"][number]["gics"];
}) {
  const t = useCopy(),
    { update } = useRouteState("push");
  const { locale } = useLocale();
  const { ready } = useAssistant();
  const [expanded, setExpanded] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const facts = context?.financialFacts ?? data.financialFacts;
  const period =
    facts?.periods?.find((p) => p.id === facts.latestTtm) ??
    facts?.periods
      ?.filter((p) => p.kind === "annual")
      .sort((a, b) => a.providerEnd.localeCompare(b.providerEnd))
      .at(-1);
  const info = object(object(context?.fundamentals ?? data.fundamentals).metrics),
    impact = data.portfolioImpact;
  const get = facts ? factIndex(facts) : () => undefined;
  const keys = ["revenue", "operatingMargin", "netIncome", "freeCashflow"];
  const evidence = object(context?.researchEvidence ?? data.researchEvidence),
    filings = objects(evidence.filings)
      .filter((f) => safeUrl(str(f.url)))
      .slice(0, 3);
  const date = nextEarningsDate(data, new Date());
  const profile = object(context?.fundamentals ?? data.fundamentals);
  // GICS from the security master is the classification look-through uses too.
  const classification = (
    gics?.sectorName ? [gics.sectorName, gics.industryName] : [profile.sector, profile.industry]
  )
    .map(str)
    .filter(Boolean)
    .map((name) => industryName(name, locale));
  const summary = str(info.longBusinessSummary);
  const excerpt = businessExcerpt(summary);
  const expandable = excerpt.length < summary.length;
  // With MaxAI on, the provider's English description can be restated in Chinese.
  const offerSummary = ready && locale === "zh" && Boolean(summary) && Boolean(data.runId);
  const citation = useProfileCitation(summary, data.ticker);
  const description = useRef<HTMLParagraphElement>(null);
  const missingNote = useRef<HTMLParagraphElement>(null);
  // A followed citation shows its sentence in place and takes focus there.
  useEffect(() => {
    if (!citation.key) return;
    const target = citation.missing ? missingNote.current
      : citation.index >= 0 ? description.current?.querySelector<HTMLElement>(`[data-profile-sentence="${citation.index}"]`)
      : description.current;
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.focus({ preventScroll: true });
    target.setAttribute("data-assistant-evidence", "");
    const clear = setTimeout(() => target.removeAttribute("data-assistant-evidence"), 2800);
    return () => {
      clearTimeout(clear);
      target.removeAttribute("data-assistant-evidence");
    };
  }, [citation.key, citation.index, citation.missing]);
  return (
    <Bento className="mx-overview-bento">
      {period && (
        <Panel
          bare
          className="mx-bento-wide"
          title={t("经营要点", "Operating facts")}
          action={
            <span>
              {period.label} · {facts?.currency ?? "—"}
            </span>
          }
        >
          <div className="mx-metric-grid mx-overview-facts">
            {keys
              .filter((key) => get(period.id, key)?.value != null)
              .map((key) => {
                const value = get(period.id, key)!;
                return (
                  <button
                    className="mx-fact-button"
                    key={key}
                    onClick={() =>
                      update({
                        view: "fundamentals",
                        frequency: period.kind,
                        period: period.id,
                        financialMode: "performance",
                        metricGroup:
                          key.toLowerCase().includes("cashflow") ||
                          key === "fcfMargin"
                            ? "cashflow"
                            : key.includes("Margin")
                              ? "margins"
                              : "income",
                        fact: key,
                      })
                    }
                  >
                    <Metric
                      label={t(...metricNames[key])}
                      value={
                        value.unit === "ratio"
                          ? percent(value.value, key.endsWith("Growth"))
                          : compact(value.value, locale)
                      }
                    />
                  </button>
                );
              })}
          </div>
        </Panel>
      )}
        <Panel
          bare
          title={
            <LensTitle
              label={t("业务", "Business")}
              onOpen={() =>
                update({ view: "fundamentals", financialMode: "business", frequency: "annual" })
              }
            />
          }
          action={
            safeUrl(str(info.website)) ? (
              <a
                className="mx-text-link"
                href={safeUrl(str(info.website))}
                target="_blank"
                rel="noreferrer"
              >
                {t("公司网站", "Company website")} ↗
              </a>
            ) : undefined
          }
        >
          <p className="mx-company-sector">
            {classification.join(" / ")}
          </p>
          {Boolean(summary) &&
            (citation.reveal ? (
              // The whole description, sentence by sentence, around the cited one.
              <p ref={description} className="mx-business-description" lang="en" tabIndex={citation.index < 0 ? -1 : undefined}>
                {citation.sentences.map((sentence, i) => (
                  <span key={i} className="mx-profile-sentence" data-profile-sentence={i} tabIndex={i === citation.index ? -1 : undefined}>
                    {sentence}{i < citation.sentences.length - 1 && " "}
                  </span>
                ))}
              </p>
            ) : expandable ? (
              // The excerpt itself opens and closes the full description. The source
              // profile is English; lang lets screen readers and line breaking follow it.
              <p
                className={expanded ? "mx-business-description" : "mx-business-excerpt"}
                lang="en"
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                data-expandable=""
                onClick={() => setExpanded(!expanded)}
                onKeyDown={(event) => {
                  if (!isImeComposing(event) && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    setExpanded(!expanded);
                  }
                }}
              >
                {expanded ? summary : excerpt + " …"}
              </p>
            ) : (
              <p className="mx-business-description" lang="en">
                {summary}
              </p>
            ))}
          {citation.missing && (
            <p ref={missingNote} className="mx-citation-missing" role="status" tabIndex={-1}>
              {t("引用的句子已不在当前公司介绍中。", "The cited sentence is no longer in this company description.")}
            </p>
          )}
          {offerSummary && (
            <button type="button" className="mx-summary-trigger" aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen(!summaryOpen)}>
              ✦ {t("中文摘要", "Chinese summary")}
            </button>
          )}
          {offerSummary && summaryOpen && (
            <PageInspection
              role="company-summary"
              object={data.ticker}
              context={{ ticker: data.ticker }}
              snapshotId={data.runId}
              search={new URLSearchParams({ ticker: data.ticker, view: "overview", scope: "broker_total" }).toString()}
              register={false}
              onClose={() => setSummaryOpen(false)}
            />
          )}
        </Panel>
        <Panel
          bare
          title={
            <LensTitle
              label={t("近期披露与预期", "Disclosures & expectations")}
              onOpen={() => update({ view: "analyst", analystView: "forecast" })}
            />
          }
        >
          {date && (
            <button
              className="mx-event-link"
              onClick={() => update({ view: "analyst", analystView: "events" })}
            >
              <span>{t("下次财报", "Next report")}</span>
              <strong>{formatCalendarDate(date, locale)}</strong>
            </button>
          )}
          <div className="mx-document-feed">
            {filings.map((f, i) => (
              <article key={i}>
                <time dateTime={str(f.date).slice(0, 10)}>{formatCalendarDate(str(f.date), locale)}</time>
                <a href={safeUrl(str(f.url))} target="_blank" rel="noreferrer">
                  {filingTitle(str(f.form), str(f.title), t)} ↗
                </a>
              </article>
            ))}
          </div>
        </Panel>
      {impact && impact.exposureValueGbp > 0 && (
        <Panel
          bare
          className="mx-bento-wide"
          title={
            <Link className="mx-ranking-link" href={`/holdings?q=${encodeURIComponent(data.ticker)}`}>
              {t("我的敞口", "My exposure")}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
        >
          <div className="mx-metric-grid">
            <Metric
              label={t("直接持有", "Direct")}
              value={currency(impact.directValueGbp)}
            />
            <Metric
              label={t("基金内持有", "Via funds")}
              value={currency(impact.indirectValueGbp)}
            />
            <Metric
              label={t("组合占比", "Portfolio weight")}
              value={percent(impact.allocationPct)}
            />
            <Metric
              label={t("持有账户", "Accounts")}
              value={
                impact.holdingAccounts
                  .map((a) => (a === "A" ? "Invest" : a === "B" ? "ISA" : a))
                  .join(" · ") || "—"
              }
            />
          </div>
          {impact.etfContributors.length > 0 && (
            <details>
              <summary>{t("基金来源", "Fund contributors")}</summary>
              <Facts
                rows={impact.etfContributors.map((raw) => {
                  const r = object(raw);
                  return [
                    `${str(r.ticker ?? r.fundTicker ?? r.etf)}${r.asOf ? " · " + formatCalendarDate(str(r.asOf), locale) : ""}`,
                    currency(r.valueGbp ?? r.exposureValueGbp),
                  ];
                })}
              />
            </details>
          )}
        </Panel>
      )}
    </Bento>
  );
}
