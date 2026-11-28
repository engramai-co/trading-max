"use client";

import { citedEventKind } from "@/lib/cited-calendar-event";
import { useEffect } from "react";
import { focusAssistantControl } from "./focus";

let pending: { key: string; until: number; localRecord?: () => HTMLElement | null } | null = null;
const citationActivated = "trading-max:citation-activated";
function citationKey(path: string, params: URLSearchParams) {
  params.sort();
  return path + "?" + params;
}

export function beginCitationNavigation(href: string, localRecord?: () => HTMLElement | null) {
  const url = new URL(href, window.location.href);
  pending = { key: citationKey(url.pathname, url.searchParams), until: Date.now() + 8000, localRecord };
  window.dispatchEvent(new Event(citationActivated));
}

const targets: Record<string, string> = {
  portfolio_overview: "[data-cited-account]", period_performance: ".mx-performance-chart",
  compare_benchmarks: ".mx-performance-chart", list_holdings: ".mx-holdings-list",
  position_detail: ".mx-holdings-list", lookthrough_exposure: ".mx-exposure-result",
  selected_daily: ".mx-performance-chart", selected_fx: ".mx-performance-chart",
  selected_exposure: ".mx-allocation-details, .mx-table-wrap",
  daily_returns: ".mx-performance-chart", selected_money: ".mx-performance-chart", holding_fx_split: ".mx-performance-chart",
  dated_exposure: ".mx-allocation-details, .mx-table-wrap", exposure_benchmark: ".mx-allocation-details, .mx-table-wrap",
  market_sector: ".mx-sector-detail", global_map: ".mx-global-panel", update_issue: ".mx-health-hero",
  recent_decisions: ".mx-review-page", read_research_lens: ".mx-research-content", company_profile: "[data-cited-research]",
  read_valuation_evidence: ".mx-research-content", data_freshness: ".mx-health-symbol",
};
function focusSelector(pathname: string, params: URLSearchParams) {
  if (pathname === "/holdings" && params.get("view") === "lookthrough") {
    if (!params.has("category")) return ".mx-exposure-result, .mx-exposure-basis, [data-cited-missing]";
    if (params.get("group")) return ".mx-allocation-details h3, .mx-allocation-details";
    if (params.get("dimension") === "company") return ".mx-cited-holding-details, .mx-allocation-details";
    return "[data-cited-allocation], [data-cited-missing]";
  }
  if (pathname === "/analytics") {
    if (params.get("view") === "risk") return ".mx-performance-risk[data-citation-ready] h2";
    if (params.has("moneyFrom")) return "[data-cited-money], [data-period-net-pnl], .mx-performance-unavailable";
    return ".mx-performance-chart h2[data-citation-ready], .mx-performance-unavailable";
  }
  if ((pathname === "/health" || pathname === "/activity") && params.has("job")) return ".mx-health-drawer-body h3, .mx-health-drawer [data-cited-missing]";
  if (pathname === "/sectors" && params.has("region")) return ".mx-global-inspect-head, [data-cited-missing]";
  if (pathname === "/review") return params.has("decision") ? ".mx-decision-focus .mx-row-link" : params.has("habit") ? ".mx-review-filter" : ".mx-review-page h1";
  if (pathname === "/research") {
    if (params.get("evidence") === "company_profile") return "[data-cited-research]";
    if (params.has("eventId") || params.has("calendarEventId")) return "[data-reading-event] h3, [data-cited-research]";
    if (params.has("field") || params.has("observation")) return "[data-cited-research]";
  }
  return undefined;
}

export function useEvidenceHighlight(pathname: string, search: string) {
  useEffect(() => {
    const params = new URLSearchParams(search);
    const tool = params.get("evidence");
    const analystView = params.get("analystView");
    const analystAnchor = (tool === "news_and_events" || tool === "decision_timing_and_habits") &&
      (analystView === "events" || analystView === "actions") ? "#research-" + analystView : null;
    const citedResearch = pathname === "/research" && params.has("evidenceId") && (params.has("snapshotId") || params.has("unavailable"));
    const selector = analystAnchor ?? (citedResearch ? "[data-cited-research]" : tool === "read_research_lens" && citedEventKind(params.get("event"))
      ? "[data-reading-event]" : tool === "period_performance" && params.has("moneyFrom") ? "[data-cited-money], [data-period-net-pnl], .mx-performance-unavailable" : tool && targets[tool]);
    const main = document.getElementById("main-content");
    const key = citationKey(window.location.pathname, new URLSearchParams(search));
    const isPending = () => pending?.key === key && pending.until > Date.now();
    if (!main) return;
    let target: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    function reveal(explicit: boolean) {
      if (explicit && !isPending()) return true;
      const region = selector ? main!.querySelector<HTMLElement>(selector) : null;
      const focusTarget = explicit ? (analystAnchor ? `${analystAnchor} h2` : focusSelector(pathname, params)) : null;
      const localRecord = explicit && pending?.localRecord;
      const element = localRecord ? localRecord() : focusTarget ? document.querySelector<HTMLElement>(focusTarget)
        : explicit ? region?.querySelector<HTMLElement>("h1, h2, h3") ?? region : null;
      if (explicit && !element) return !localRecord && !selector && !focusTarget;
      if (!region && !element) return false;
      if (element && explicit) {
        if (!element.matches("button, a[href], [tabindex]")) element.tabIndex = -1;
        if (!focusAssistantControl(element)) return false;
        element.scrollIntoView({block:"nearest", behavior:"instant"});
        pending = null;
      }
      clearTimeout(clear);
      target?.removeAttribute("data-assistant-evidence");
      target = localRecord ? element : region ?? element;
      if (!target) return true;
      stopWatching();
      target.setAttribute("data-assistant-evidence", "");
      if (!analystAnchor && !explicit) target.scrollIntoView({ block: "center", behavior: "instant" });
      clear = setTimeout(() => target?.removeAttribute("data-assistant-evidence"), 2800);
      return true;
    }
    function stopWatching() {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(deadline);
    }
    function watch(explicit: boolean) {
      stopWatching();
      function retry() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { if (reveal(explicit)) stopWatching(); });
      }
      if (!explicit && reveal(false)) return;
      observer = new MutationObserver(retry);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-citation-ready", "inert", "data-base-ui-inert", "aria-hidden", "data-closed"] });
      if (explicit) retry();
      deadline = setTimeout(stopWatching, 8000);
    }
    function onActivation() {
      if (isPending()) watch(true);
    }
    window.addEventListener(citationActivated, onActivation);
    if (isPending()) watch(true);
    else if (selector) watch(false);
    return () => {
      window.removeEventListener(citationActivated, onActivation);
      stopWatching();
      clearTimeout(clear);
      target?.removeAttribute("data-assistant-evidence");
    };
  }, [pathname, search]);
}
