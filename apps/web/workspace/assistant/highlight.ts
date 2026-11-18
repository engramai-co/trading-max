"use client";

import { useEffect } from "react";

const targets: Record<string, string> = {
  portfolio_overview: ".mx-overview-totals", period_performance: ".mx-performance-chart",
  compare_benchmarks: ".mx-performance-chart", list_holdings: ".mx-holdings-list",
  position_detail: ".mx-holdings-list", lookthrough_exposure: ".mx-exposure-result",
  daily_returns: ".mx-performance-chart", selected_money: ".mx-performance-chart", holding_fx_split: ".mx-performance-chart",
  dated_exposure: ".mx-allocation-details, .mx-table-wrap", exposure_benchmark: ".mx-allocation-details, .mx-table-wrap",
  market_sector: ".mx-sector-detail", global_map: ".mx-global-panel", update_issue: ".mx-health-hero",
  recent_decisions: ".mx-review-page", read_research_lens: ".mx-research-content",
  read_valuation_evidence: ".mx-research-content", data_freshness: ".mx-health-symbol",
};
export function useEvidenceHighlight(pathname: string, search: string) {
  useEffect(() => {
    const params = new URLSearchParams(search);
    const tool = params.get("evidence");
    const selector = tool === "read_research_lens" && ["earnings","earningsWindow","exDividend"].includes(params.get("event") ?? "")
      ? "[data-reading-event]" : tool === "period_performance" && params.has("moneyFrom") ? "[data-period-net-pnl]" : tool && targets[tool];
    const main = document.getElementById("main-content");
    if (!selector || !main) return;
    let target: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let clear: ReturnType<typeof setTimeout>;
    function reveal() {
      target = main!.querySelector<HTMLElement>(selector!);
      if (!target) return false;
      observer?.disconnect();
      target.setAttribute("data-assistant-evidence", "");
      target.scrollIntoView({ block: "center", behavior: "instant" });
      clear = setTimeout(() => target?.removeAttribute("data-assistant-evidence"), 2800);
      return true;
    }
    if (!reveal()) {
      observer = new MutationObserver(reveal);
      observer.observe(main, { childList: true, subtree: true });
    }
    const deadline = setTimeout(() => observer?.disconnect(), 8000);
    return () => { observer?.disconnect(); clearTimeout(deadline); clearTimeout(clear); target?.removeAttribute("data-assistant-evidence"); };
  }, [pathname, search]);
}
