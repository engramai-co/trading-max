import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { verifiedLines } from "./chat-reply";
import { evidenceHref } from "./evidence";
import results from "./research-figures.fixture.json";

// Outputs recorded by running all four research tools on test_research_readings' synthetic publication.
type Tool = keyof typeof results;
function message(tool: Tool, field: string, line?: string): UIMessage {
  const output = results[tool];
  return {id:"turn",role:"assistant",parts:[
    {type:"dynamic-tool",toolName:tool,toolCallId:"research",state:"output-available",input:{args:{ticker:"TEST"}},output},
    {type:"text",text:(line ?? "{{" + field + "}}") + " [" + output.evidence_id + "]\n{{attribution}} [inference]"},
  ]};
}

describe("research follow-up citations", () => {
  it.each([
    ["research_position","/data/change","-6.25%","eventDate=2026-02-03"],
    ["research_position","/data/trade_date","2026-01-28","eventDate=2026-01-28"],
    ["research_position","/data/event/date","Earnings reported","eventId=report"],
    ["price_key_moments","/data/items/0/move_fraction","+6.25%","eventDate=2026-01-30"],
    ["research_earnings","/data/report/actual","$1.20/share","eventId=report"],
    ["research_earnings","/data/report/surprise","+4.35%","eventId=report"],
    ["research_earnings","/data/estimates/0/mean","$1.25/share","analystView=forecast"],
    ["research_headline","/data/title","Also reported · Issuer publishes outlook","https://example.invalid/outlook"],
  ] as const)("renders the actual %s field %s and opens its source", (tool, field, expected, href) => {
    const [line] = verifiedLines(message(tool,field));
    expect(line.text).toContain(expected);
    expect(evidenceHref(line.evidence!)).toContain(href);
    if (tool === "price_key_moments") expect(line.text).toContain("limited coverage");
    if (tool === "research_headline") expect(line.evidence?.publisher).toBe("Example Wire");
  });
  it("withholds invented figures, missing values and unit overrides in either language", () => {
    for (const claim of ["EPS $7.99", "每股收益 7.99", "{{/data/report/actual}} GBP", "{{/data/items/1/move_fraction}}"]) {
      expect(verifiedLines(message("research_earnings","",claim))).toEqual([]);
    }
    expect(verifiedLines(message("price_key_moments","/data/items/0/volume_z_score"))).toEqual([]);
    const [estimate] = verifiedLines(message("research_earnings","/data/estimates/0/mean"),"zh");
    for (const term of ["2026-02-03","2026-03-31","每股收益","$1.25/股"]) expect(estimate.text).toContain(term);
  });
});
