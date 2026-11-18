import { describe, expect, it } from "vitest";
import { chatContext, displayTurns, evidenceHref, messageEvidence, verifiedLines } from "./evidence";
import type { UIMessage } from "ai";

describe("assistant evidence routing", () => {
  it("routes the tool call's actual scope and ticker", () => {
    const ref = {evidenceId:"ev_test", source:"holdings" as const, tool:"list_holdings", arguments:{scope:"isa",ticker:"SYNT"}};
    expect(evidenceHref(ref)).toBe("/holdings?account=B&q=SYNT&evidence=list_holdings");
    expect(evidenceHref({...ref, tool:"made_up"})).toBeNull();
  });
  it("recovers references from the same message's tool output", () => {
    const message: UIMessage = {id:"a",role:"assistant",parts:[{type:"dynamic-tool",toolName:"read_research_lens",toolCallId:"c",state:"output-available",
      input:{args:{ticker:"SYNT",lens:"technical"}},output:{evidence_id:"ev_test"}}]};
    const text: UIMessage = {id:"result", role:"assistant", parts:[{type:"text", text:"A reading [ev_test]"}]};
    const user: UIMessage = {id:"u", role:"user", parts:[{type:"text",text:"Another turn"}]};
    const turns = displayTurns([message, text, user, text]);
    expect(turns).toHaveLength(3);
    expect(messageEvidence(turns[0]).has("ev_test")).toBe(true);
    expect(messageEvidence(turns[2]).size).toBe(0);
    expect(messageEvidence(message).get("ev_test")?.source).toBe("technical");
    expect(chatContext("holdings","q=untrusted&account=A","Europe/London")).toEqual({page:"holdings",scope:"invest",timezone:"Europe/London"});
  });
});

it("opens the money metric at its exact snapshot and highlights the specified event", () => {
  const ref = {evidenceId:"ev_date", source:"account" as const, tool:"period_performance", arguments:{scope:"broker_total",range:"1W",metric:"period_pnl_gbp",start:"2026-01-03",end:"2026-01-09",snapshotId:"prior"}};
  const params = new URL(evidenceHref(ref)!, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({view:"money",range:"1W",moneyFrom:"2026-01-03",moneyTo:"2026-01-09",snapshotId:"prior"});
  const ex = evidenceHref({...ref, tool:"read_research_lens", arguments:{ticker:"TEST",lens:"analyst",event:"exDividend",date:"2026-11-28"}});
  expect(ex).toContain("event=exDividend");
});

it("accepts two to four lines only with a turn-local source or a non-numeric inference", () => {
  const reply = (text: string): UIMessage => ({id:"result",role:"assistant",parts:[
    {type:"dynamic-tool",toolName:"portfolio_overview",toolCallId:"a",state:"output-available",input:{},output:{evidence_id:"ev_local"}},
    {type:"text",text},
  ]});
  const fact = "The result was £4 [ev_local]";
  const inference = "The records may be incomplete [inference]";
  expect(verifiedLines(reply(fact+"\n"+inference))).toHaveLength(2);
  for (const invalid of [fact, Array(5).fill(fact).join("\n"), fact+"\n£5 [inference]", fact+"\nUnknown [ev_elsewhere]"]) {
    expect(verifiedLines(reply(invalid))).toEqual([]);
  }
});

it("keeps the selected research lens, object and evidence destination", () => {
  const evidence = { evidenceId: "ev_reading", source: "market" as const, tool: "price_key_moments",
    arguments: { ticker: "SYNT.L", date: "2026-02-03", lens: "technical" } };
  const link = new URL(evidenceHref(evidence)!, "https://example.invalid");
  expect(Object.fromEntries(link.searchParams)).toMatchObject({ ticker: "SYNT.L", view: "technical", eventDate: "2026-02-03", interval: "1d" });
  expect(chatContext("research","type=index&index=sample&ticker=%5ETEST&view=price&scope=broker_total","Europe/London"))
    .toMatchObject({ page: "research", ticker: "^TEST", lens: "technical", scope: "broker_total" });
  const story = { ...evidence, tool: "research_headline", source: "publisher" as const, arguments: {ticker:"SYNT",url:"https://example.invalid/news"} };
  expect(evidenceHref(story)).toBe(story.arguments.url);
  expect(evidenceHref({...story, arguments:{...story.arguments,url:"javascript:alert(1)"}})).not.toMatch(/^javascript:/);
});
