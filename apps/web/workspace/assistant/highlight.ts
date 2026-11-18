"use client";

import { citedEventKind } from "@/lib/cited-calendar-event";
import { useEffect } from "react";

const targets: Record<string, string> = {
  portfolio_overview: ".mx-overview-totals", period_performance: ".mx-performance-chart",
  compare_benchmarks: ".mx-performance-chart", list_holdings: ".mx-holdings-list",
  position_detail: ".mx-holdings-list", lookthrough_exposure: ".mx-exposure-result",
  recent_decisions: ".mx-review-page", read_research_lens: ".mx-research-content",
  read_valuation_evidence: ".mx-research-content", data_freshness: ".mx-health-symbol",
};
export function useEvidenceHighlight(pathname: string, search: string) {
  useEffect(() => {
    const params = new URLSearchParams(search);
    const tool = params.get("evidence");
    const selector = tool === "read_research_lens" && citedEventKind(params.get("event"))
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
