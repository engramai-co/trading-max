"use client";
import type { ResearchLensSnapshot } from "@/lib/types";
import { Button } from "@mantine/core";
import { useState } from "react";
import {
  compact,
  currency,
  object,
  objects,
  percent,
  safeUrl,
  str,
} from "./data";
import { Facts, Metric, Panel, TextLink, useCopy } from "./foundation";
import { factIndex, metricNames } from "./research-facts";
import { useRouteState } from "./route-state";
export function CompanyOverview({
  data,
  context,
}: {
  data: ResearchLensSnapshot;
  context?: ResearchLensSnapshot;
}) {
  const t = useCopy(),
    { update } = useRouteState("push");
  const [expanded, setExpanded] = useState(false);
  const facts = context?.financialFacts ?? data.financialFacts;
  const period =
    facts?.periods?.find((p) => p.id === facts.latestTtm) ??
    facts?.periods
      ?.filter((p) => p.kind === "annual")
      .sort((a, b) => a.providerEnd.localeCompare(b.providerEnd))
      .at(-1);
  const info = object(object(context?.fundamentals).metrics),
    impact = data.portfolioImpact;
  const get = facts ? factIndex(facts) : () => undefined;
  const keys = ["revenue", "operatingMargin", "netIncome", "freeCashflow"];
  const evidence = object(context?.researchEvidence ?? data.researchEvidence),
    filings = objects(evidence.filings)
      .filter((f) => safeUrl(str(f.url)))
      .slice(0, 3);
  const calendar = object(object(context?.fundamentals).earningsCalendar),
    date = str((calendar.earningsDates as unknown[] | undefined)?.[0]).slice(
      0,
      10,
    );
  return (
    <>
      {period && (
        <Panel
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
      <div className="mx-grid mx-overview-context">
        <Panel
          title={t("业务", "Business")}
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
            {[
              object(context?.fundamentals).sector,
              object(context?.fundamentals).industry,
            ]
              .filter(Boolean)
              .map(str)
              .join(" / ")}
          </p>
          {Boolean(info.longBusinessSummary) && (
            <>
              <p
                className={
                  expanded ? "mx-business-description" : "mx-business-excerpt"
                }
              >
                {expanded
                  ? str(info.longBusinessSummary)
                  : str(info.longBusinessSummary)
                      .split(/(?<=\.)\s+(?=[A-Z])/)
                      .slice(0, 2)
                      .join(" ")}
              </p>
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
              >
                {expanded
                  ? t("收起", "Less")
                  : t("完整业务简介", "Full description")}
              </Button>
            </>
          )}
          <div style={{ marginTop: 18 }}>
            <TextLink
              href={`/research?ticker=${data.ticker}&view=fundamentals&financialMode=business&frequency=annual`}
            >
              {t("收入来自哪些业务与地区", "Revenue by business & geography")}
            </TextLink>
          </div>
        </Panel>
        <Panel title={t("近期披露与预期", "Disclosures & expectations")}>
          {date && (
            <button
              className="mx-event-link"
              onClick={() => update({ view: "analyst", analystView: "events" })}
            >
              <span>{t("下一财报窗口", "Next earnings window")}</span>
              <strong>{date}</strong>
            </button>
          )}
          <div className="mx-document-feed">
            {filings.map((f, i) => (
              <article key={i}>
                <time>{str(f.date).slice(0, 10)}</time>
                <a href={safeUrl(str(f.url))} target="_blank" rel="noreferrer">
                  {str(f.form)} · {str(f.title)} ↗
                </a>
              </article>
            ))}
          </div>
          <div style={{ marginTop: 18 }}>
            <TextLink href={`/research?ticker=${data.ticker}&view=analyst`}>
              {t(
                "查看业绩预期与机构调整",
                "Earnings expectations & analyst actions",
              )}
            </TextLink>
          </div>
        </Panel>
      </div>
      {impact && impact.exposureValueGbp > 0 && (
        <Panel
          title={t("我的敞口", "My exposure")}
          action={
            <TextLink href={`/holdings?q=${data.ticker}`}>
              {t("查看持仓", "Holdings")}
            </TextLink>
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
                    `${str(r.ticker ?? r.fundTicker ?? r.etf)}${r.asOf ? " · " + str(r.asOf) : ""}`,
                    currency(r.valueGbp ?? r.exposureValueGbp),
                  ];
                })}
              />
            </details>
          )}
        </Panel>
      )}
    </>
  );
}
