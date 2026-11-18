import { describe, expect, it } from "vitest";
import { scopedDecisions, type ScopedDecision } from "./review-board";
import { decisionContext, habitDecisions } from "./review-patterns";
import { evidenceHref } from "./assistant/evidence";

describe("trading habit scope", () => {
  const first: ScopedDecision = {
    account: "A",
    date: "2026-09-02",
    side: "buy",
    kind: "B",
    ticker: "SYN",
    name: "Synthetic",
    amountGbp: 100,
    basketBuy: true,
  };
  const twin: ScopedDecision = { ...first, name: "Second listing", beforeEarnings: true };
  const isa: ScopedDecision = { ...first, account: "B" };
  const rows = [first, twin, isa];
  it("keeps matched broker decisions and avoids representing a no-trade observation as a fill", () => {
    expect(habitDecisions(rows, "before_earnings")).toEqual([twin]);
    expect(habitDecisions(rows, "untraded_fall")).toEqual([]);
    expect(habitDecisions(rows, null)).toBe(rows);
    const [filteredTwin] = habitDecisions(scopedDecisions("A", { status: "available", decisions: [first, twin] }), "before_earnings");
    expect(decisionContext(filteredTwin, "all", "date", "before_earnings")).toMatchObject({
      scope: "invest",
      page_scope: "broker_total",
      ordinal: 1,
      horizon: "to_date",
    });
  });
  it("links a reading to its account, decision and horizon", () => {
    const ref = {
      tool: "decision_timing_and_habits",
      source: "review" as const,
      evidenceId: "ev_x",
      arguments: {
        scope: "isa",
        side: "buy",
        decision_date: "2026-09-02",
        ticker: "TEST.L",
        horizon: "20_sessions",
      },
    };
    expect(evidenceHref(ref)).toBe(
      "/review?account=B&decision=2026-09-02.buy.TEST.L&reviewWindow=20_sessions&evidence=decision_timing_and_habits",
    );
  });
});
