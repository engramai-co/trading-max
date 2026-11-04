"use client";
import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { ArrowRight } from "@phosphor-icons/react";
import { useState } from "react";
import { compact, currency, object, objects, percent, safeUrl, str } from "@/workspace/data";
import { nextEarningsDate } from "./analyst-data";
import { industryName } from "./exposure-names";
import { Bento, Facts, Metric, Panel, useCopy } from "./foundation";
import Link from "./link";
import { factIndex, metricNames } from "./research-facts";
import { filingTitle } from "./research-filings";
import { useRouteState } from "./route-state";

/** A panel title that opens the lens holding its detail. */
function LensTitle({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button type="button" className="mx-ranking-link" onClick={onOpen}>
      {label}
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
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
  const [expanded, setExpanded] = useState(false);
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
  const date = nextEarningsDate(data, new Date().toISOString().slice(0, 10));
  const profile = object(context?.fundamentals ?? data.fundamentals);
  // GICS from the security master is the classification look-through uses too.
  const classification = (
    gics?.sectorName ? [gics.sectorName, gics.industryName] : [profile.sector, profile.industry]
  )
    .map(str)
    .filter(Boolean)
    .map((name) => industryName(name, locale));
  const summary = str(info.longBusinessSummary);
  const excerpt = summary.split(/(?<=\.)\s+(?=[A-Z])/).slice(0, 2).join(" ");
  const expandable = excerpt.length < summary.length;
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
                          : compact(value.value)
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
            (expandable ? (
              // The excerpt itself opens and closes the full description.
              <p
                className={expanded ? "mx-business-description" : "mx-business-excerpt"}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                data-expandable=""
                onClick={() => setExpanded(!expanded)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpanded(!expanded);
                  }
                }}
              >
                {expanded ? summary : excerpt + " …"}
              </p>
            ) : (
              <p className="mx-business-description">{summary}</p>
            ))}
        </Panel>
        <Panel
          bare
          title={
            <LensTitle
              label={t("近期披露与预期", "Disclosures & expectations")}
              onOpen={() => update({ view: "analyst" })}
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
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          }
        >
          <div className="mx-metric-grid">
            <Metric
              label={t("直接持有", "Direct holdings")}
              value={currency(impact.directValueGbp)}
            />
            <Metric
              label={t("基金内持有", "Through funds")}
              value={currency(impact.indirectValueGbp)}
            />
            <Metric
              label={t("合计组合占比", "Portfolio weight")}
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
