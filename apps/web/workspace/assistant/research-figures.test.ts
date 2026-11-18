import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { verifiedLines } from "./chat-reply";
import { evidenceHref } from "./evidence";
import results from "./research-figures.fixture.json";

// Outputs recorded by running the research tools on test_research_readings' synthetic publication.
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
    ["price_key_moments","/data/following/1/return_fraction","-11.76%","eventDate=2026-01-30"],
    ["research_earnings","/data/changes/0/change","Change US$0.25","analystView=forecast"],
    ["research_earnings","/data/report/actual","$1.20/share","eventId=report"],
    ["research_earnings","/data/report/surprise","+4.35%","eventId=report"],
    ["research_earnings","/data/estimates/0/mean","$1.25/share","analystView=forecast"],
    ["research_headline","/data/title","Related headline · Issuer publishes outlook","evidence=research_headline"],
    ["company_profile","/data/sentences/1","The company also offers Widget Cloud, a subscription service.","evidence=company_profile"],
  ] as const)("renders the actual %s field %s and opens its source", (tool, field, expected, href) => {
    const [line] = verifiedLines(message(tool,field));
    expect(line.text).toContain(expected);
    if (field === "/data/change" || field.endsWith("/move_fraction")) expect(line.text).toContain("Split- and dividend-adjusted return");
    if (field === "/data/changes/0/change") for (const value of ["2026-01-31","2026-02-03","$1.00","$1.25"]) expect(line.text).toContain(value);
    expect(evidenceHref(line.evidence!)).toContain(href);
    if (tool === "company_profile") expect(evidenceHref(line.evidence!)).toContain("sentence=1&sentenceId=6e2b34b5");
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

it("labels the sector index and uses only the matched window in both comparison fields", () => {
  const reply = message("research_position","/data/benchmarks/0/benchmark");
  const part = reply.parts[0];
  if (part.type !== "dynamic-tool" || part.state !== "output-available") throw new Error("missing fixture");
  const comparison = {symbol:"^106802-USD-STRD",name:"MSCI World Financials",benchmark_basis:"price-index",
    start:"2025-11-01",end:"2026-01-30",sessions:63,asset:.12,benchmark:.04};
  part.output = {...results.research_position,data:{...results.research_position.data,benchmarks:[comparison]}};
  const [line] = verifiedLines(reply);
  for (const term of ["MSCI World Financials","Index level change","2025-11-01 – 2026-01-30","+4.00%"]) expect(line.text).toContain(term);
  expect(line.text).not.toContain("2026-02-03");
});

it.each([["dividend","Reported dividend"],["ex_dividend","Ex-dividend date"],["dividend_pay","Dividend payment date"]])(
  "cites the selected chart's %s record", (kind,label) => {
    const reply = message("price_key_moments","/data/items/0/events/0/kind");
    const part = reply.parts[0];
    if (part.type !== "dynamic-tool" || part.state !== "output-available") throw new Error("missing fixture");
    const output = results.price_key_moments, selected = output.data.items[0];
    const event = {date:selected.date,kind,reference:"https://example.invalid/dividends"};
    part.output = {...output,data:{...output.data,items:[{...selected,events:[event]}]}};
    const [line] = verifiedLines(reply);
    expect(line.text).toContain(label);
    expect(line.evidence?.source).toBe("disclosure");
    const link = new URL(evidenceHref(line.evidence!)!,"http://localhost");
    expect(Object.fromEntries(link.searchParams)).toMatchObject({series:output.data.published_series_id,
      date:selected.date,event:kind,eventId:event.reference,snapshotId:output.snapshot_id});
  });
