import { describe, expect, it } from "vitest";
import { verifiedLines } from "./chat-reply";
import { chatContext, displayTurns, evidenceHref, messageEvidence, observationText } from "./evidence";
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
    {type:"dynamic-tool",toolName:"portfolio_overview",toolCallId:"a",state:"output-available",input:{},output:{evidence_id:"ev_local",status:"ok",data:{total_value_gbp:4,currency:"GBP"}}},
    {type:"text",text},
  ]});
  const fact = "{{/data/total_value_gbp}} [ev_local]";
  const inference = "{{insufficient-evidence}} [inference]";
  expect(verifiedLines(reply(fact+"\n"+inference))).toHaveLength(2);
  for (const invalid of [fact, Array(5).fill(fact).join("\n"), fact+"\n£5 [inference]", fact+"\nUnknown [ev_elsewhere]"]) {
    expect(verifiedLines(reply(invalid))).toEqual([]);
  }
});

describe("financial claims and their cited tool output", () => {
  const toolPart = {type:"dynamic-tool",toolName:"period_performance",toolCallId:"period",state:"output-available",
    input:{args:{scope:"broker_total",range:"1W"}},output:{evidence_id:"ev_period",status:"partial",scope:"broker_total",quality:{issues:["limited_observation_coverage"]},
      data:{currency:"GBP",period_pnl_gbp:21.5,window_start:"2026-11-09",window_end:"2026-11-13",coverage:"partial"}}} as const;
  function reply(first: string): UIMessage {
    return {id:"answer",role:"assistant",parts:[{...toolPart}, {type:"text",text:first+"\n{{other-drivers}} [inference]"}]};
  }
  it.each([
    "Net P&L was £9,999,999 [ev_period]", "Net P&L was $21.50 [ev_period]",
    "Net P&L was £21.50 with complete coverage [ev_period]", "Coverage was complete [ev_period]",
    "Net P&L was nine million pounds [inference]", "覆盖完整 [inference]", "{{complete-coverage}} [inference]",
    "{{/data/period_pnl_gbp}} with complete coverage [ev_period]", "{{/data/unknown}} [ev_period]",
  ])("withholds an ungrounded claim despite its real citation: %s", claim => {
    expect(verifiedLines(reply(claim))).toEqual([]);
  });
  it("renders the actual field, unit, window and partial coverage", () => {
    const lines = verifiedLines(reply("{{/data/period_pnl_gbp}} [ev_period]"));
    expect(lines).toHaveLength(2);
    for (const fragment of ["21.50", "£", "2026-11-09", "2026-11-13", "limited coverage"]) expect(lines[0].text).toContain(fragment);
  });
});

function fieldReply(toolName: string, output: Record<string, unknown>, pointer: string): UIMessage {
  return {id:"answer",role:"assistant",parts:[
    {type:"dynamic-tool",toolName,toolCallId:"tool",state:"output-available",input:{},
      output:{status:"ok",evidence_id:"ev_local", ...output}},
    {type:"text",text:`{{${pointer}}} [ev_local]\n{{insufficient-evidence}} [inference]`},
  ]};
}
it("keeps a row's subject and native unit and uses only its selected evidence", () => {
  const output = {scope:"broker_total",data:{items:[
    {ticker:"SYN",scope:"isa",price_currency:"USD",current_price:21.5,observed_at:"2026-06-01T20:00:00Z"},
    {ticker:"ALT",scope:"invest",price_currency:"GBp",current_price:18.25},
  ]}};
  const message = fieldReply("list_holdings", output, "/data/items/0/current_price");
  const [line] = verifiedLines(message, "en", "Asia/Hong_Kong");
  expect(line.text).toContain("SYN · ISA");
  expect(line.text).toMatch(/\$21\.5000/);
  expect(line.text).toContain("04:00");
  expect(line.text).not.toContain("ALT");
  for (const pointer of ["/data/items/1/unknown", "/data/items/2/current_price", "/data/constructor", "/data/items/01/current_price"]) {
    expect(verifiedLines(fieldReply("list_holdings", output, pointer))).toEqual([]);
  }
  const [pence] = verifiedLines(fieldReply("list_holdings",output,"/data/items/1/current_price"));
  expect(pence.text).toContain("18.25 GBp");
  expect(verifiedLines(fieldReply("list_holdings", {data:{items:[{current_price:3}]}}, "/data/items/0/current_price"))).toEqual([]);
});
it("uses a submetric's window and refuses unavailable or ambiguous results", () => {
  const output = {data:{window_start:"2026-01-01",window_end:"2026-03-31",twr:{status:"ok",fraction:-0.125,start:"2026-03-02",end:"2026-03-30"}}};
  const message = fieldReply("period_performance", output, "/data/twr/fraction");
  expect(verifiedLines(message)[0].text).toBe("Time-weighted return -12.50% · 2026-03-02 – 2026-03-30");
  expect(verifiedLines(fieldReply("period_performance",{...output,status:"unavailable"},"/data/twr/fraction"))).toEqual([]);
  expect(verifiedLines(fieldReply("period_performance",{status:"unavailable"},"/status"))[0].text).toBe("Data unavailable");
  const conflict = fieldReply("period_performance",{data:{twr:{status:"ok",fraction:0.7}}},"/data/twr/fraction");
  expect(verifiedLines({...message,parts:[...message.parts,conflict.parts[0]]})).toEqual([]);
});
it("derives coverage from the whole tool result and uses the reader's language", () => {
  const output = {quality:{issues:["some_benchmarks_unavailable"]},data:{coverage:"complete",portfolio_twr_fraction:0.12}};
  for (const target of ["/data/portfolio_twr_fraction", "/data/coverage", "/status"]) {
    const [line, inference] = verifiedLines(fieldReply("compare_benchmarks",output,target),"zh");
    expect(line.text).toContain("覆盖不完整");
    expect(line.text).not.toContain("覆盖完整");
    expect(inference.text).toContain("证据不足");
  }
});
it("reads quotation currency from the same research dataset and normalised valuation row", () => {
  const data = {ticker:"SYN",items:[{dataset:"technical",path:"/price",value:25.125},
    {dataset:"market",path:"/currency",value:"EUR"},{dataset:"technical",path:"/currency",value:"GBP"}]};
  const [price] = verifiedLines(fieldReply("read_research_lens",{data},"/data/items/0/value"));
  expect(price.text).toContain("£25.1250");
  const row = {metric:"spot",unit:"perShare",state:"available",currency:"GBP",native_quote_unit:"GBp",value:1.25};
  const [valuation] = verifiedLines(fieldReply("read_valuation_evidence",{data:{items:[row]}},"/data/items/0/value"));
  expect(valuation.text).toContain("£1.2500/share");
});

it("opens the earnings and ratings sections from their own evidence", () => {
  for (const section of ["events","actions","ratings"]) {
    const href = evidenceHref({evidenceId:"ev_source",tool:"news_and_events",source:section === "events" ? "financials" : "analysts",arguments:{ticker:"TEST",lens:"analyst",analystView:section}});
    const url = new URL(href!, "http://localhost");
    expect(url.searchParams.get("analystView")).toBe(section === "ratings" ? "actions" : section);
    expect(url.hash).toBe("#research-" + (section === "ratings" ? "actions" : section));
  }
});

it.each(["events", "actions", "ratings"])("opens the selected listing’s %s section from a decision", section => {
  const href = evidenceHref({evidenceId: "ev_decision", tool: "decision_timing_and_habits",
    source: section === "events" ? "financials" : "analysts",
    arguments: {ticker: "TEST", listing: "TEST.L", lens: "analyst", analystView: section,
      snapshotId:"saved-run", calendarEventId:"ev_0123456789abcdef", date:"2026-08-28"}});
  const opened = new URL(href!, "https://example.org");
  expect(opened.pathname).toBe("/research");
  expect(opened.searchParams.get("ticker")).toBe("TEST.L");
  expect(Object.fromEntries(opened.searchParams)).toMatchObject({snapshotId:"saved-run", calendarEventId:"ev_0123456789abcdef", date:"2026-08-28"});
  expect(opened.hash).toBe("#research-" + (section === "ratings" ? "actions" : section));
});

it.each([
  ["en", "Technical data", "Stale", "Earnings data", "Missing"],
  ["zh", "技术指标", "已过时", "业绩数据", "缺失"],
] as const)("identifies each freshness dataset and its state in %s", (locale, technical, stale, earnings, missing) => {
  const output = {scope:"invest", sources:[{as_of:"2026-11-01"}], data:{ticker:"SYNT", items:[
    {dataset:"technical", state:"stale", as_of:"2026-11-01"},
    {dataset:"earnings", state:"missing", as_of:null},
  ]}};
  const reply = fieldReply("data_freshness", output, "/data/items/0/state");
  reply.parts[1] = {type:"text", text:"{{/data/items/0/state}} [ev_local]\n{{/data/items/1/state}} [ev_local]"};
  const [first, second] = verifiedLines(reply, locale);
  for (const text of ["SYNT", technical, stale, "2026-11-01"]) expect(first.text).toContain(text);
  for (const text of ["SYNT", earnings, missing]) expect(second.text).toContain(text);
  expect(second.text).not.toContain("2026-11-01");
});

it("restores the server-bound selection from a completed tool when the model omitted it", () => {
  const message: UIMessage = {id:"role",role:"assistant",parts:[{type:"dynamic-tool",toolName:"list_holdings",toolCallId:"c",state:"output-available",
    input:{args:{sort:"value"}},output:{evidence_id:"ev_selected",bound_arguments:{scope:"isa",ticker:"SYNT",snapshotId:"older",ordinal:"0"}}}]};
  expect(messageEvidence(message).get("ev_selected")?.arguments).toEqual({scope:"isa",ticker:"SYNT",snapshotId:"older",ordinal:"0",sort:"value"});
});

it("keeps the selected benchmark window in the link when observations cover fewer dates", () => {
  const message = fieldReply("compare_benchmarks", {bound_arguments:{scope:"isa",start:"2026-10-01",end:"2026-11-01"},
    data:{start:"2026-10-02",end:"2026-10-30",portfolio_twr_fraction:0.02}}, "/data/portfolio_twr_fraction");
  const [line] = verifiedLines(message);
  expect(line.text).toContain("2026-10-02 – 2026-10-30");
  expect(line.evidence?.arguments).toMatchObject({scope:"isa",start:"2026-10-01",end:"2026-11-01"});
});

it.each([{}, {snapshotId:"previous"}])("reopens benchmark evidence on its published snapshot", (bound) => {
  const reply = fieldReply("compare_benchmarks", {snapshot_id:"previous",bound_arguments:{...bound, scope:"isa",benchmark:"VOO"},
    data:{start:"2026-02-02",end:"2026-02-03",portfolio_twr_fraction:0.02}}, "/data/portfolio_twr_fraction");
  const [line] = verifiedLines(reply);
  const params = new URL(evidenceHref(line.evidence!)!, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toMatchObject({view:"returns",scope:"isa",benchmark:"VOO",returnFrom:"2026-02-02",returnTo:"2026-02-03",snapshotId:"previous"});
});

it("projects timed releases into the reader's day and preserves date-only earnings windows", () => {
  const text = "2026-02-04 · CPI";
  const macro = {en:text,zh:text,evidence:{source:"calendar" as const,tool:"upcoming_events",evidenceId:"ev_cal",
    arguments:{date:"2026-02-04", instant:"2026-02-05T08:30:00+09:00", url:"https://example.org/calendar"}}};
  expect(observationText(macro,"en","Asia/Tokyo")).toMatch(/5 Feb 2026.*08:30.* · CPI/);
  expect(observationText(macro,"en","Europe/London")).toMatch(/4 Feb 2026.*23:30.* · CPI/);
  expect(evidenceHref(macro.evidence)).toBe("https://example.org/calendar");
  const earnings = {en:"2026-02-06 – 2026-02-08 · TEST earnings",zh:"财报",evidence:{...macro.evidence,source:"financials" as const,
    arguments:{snapshotId:"old",eventId:"ev_earn",holdingTicker:"TEST", event:"earningsWindow",date:"2026-02-06",endDate:"2026-02-08"}}};
  expect(observationText(earnings,"en","America/New_York")).toBe(earnings.en);
  expect(evidenceHref(earnings.evidence)).toContain("event=earningsWindow&date=2026-02-06&end=2026-02-08");
});

it("keeps a historical benchmark with no publication ID from opening today's figures", () => {
  expect(evidenceHref({tool:"compare_benchmarks",source:"market",evidenceId:"ev_old",arguments:{scope:"isa",benchmark:"VOO"}})).toBeNull();
});

it("carries both the calendar row and publication into the earnings target", () => {
  const ref = {source:"financials" as const, tool:"upcoming_events",evidenceId:"ev_page",
    arguments:{snapshotId:"old",eventId:"ev_calendar_row",researchEventId:"earn-1",date:"2026-02-04",holdingTicker:"TEST",event:"earnings"}};
  expect(Object.fromEntries(new URL(evidenceHref(ref)!, "http://localhost").searchParams)).toMatchObject({
    snapshotId:"old",calendarEventId:"ev_calendar_row",eventId:"earn-1",ticker:"TEST",date:"2026-02-04"
  });
});

it("reads the selected calendar row's title, Tokyo day and exact source", () => {
  const output = {snapshot_id:"saved",data:{items:[
    {kind:"macro",evidence_id:"ev_prices",title_en:"Consumer prices",title_zh:"消费者价格",date:"2026-02-03",instant:"2026-02-03T23:30:00Z",source_url:"https://example.org/prices"},
    {kind:"earnings",ticker:"SYNT",evidence_id:"ev_report",research_event_id:"report",title_en:"Earnings",date:"2026-02-05"},
  ]}};
  const [macro] = verifiedLines(fieldReply("upcoming_events",output,"/data/items/0/date"),"en","Asia/Tokyo");
  expect(macro.text).toMatch(/Consumer prices.*4 Feb 2026.*08:30/);
  expect(evidenceHref(macro.evidence!)).toBe("https://example.org/prices");
  const [earnings] = verifiedLines(fieldReply("upcoming_events",output,"/data/items/1/date"),"en","Asia/Tokyo");
  expect(earnings.text).toBe("SYNT · Earnings · 2026-02-05");
  expect(earnings.evidence?.source).toBe("financials");
  expect(Object.fromEntries(new URL(evidenceHref(earnings.evidence!)!, "http://localhost").searchParams)).toMatchObject({
    snapshotId:"saved",calendarEventId:"ev_report",eventId:"report",date:"2026-02-05",ticker:"SYNT"
  });
});

it.each([
  ["cancelled","2026-03-05",null,"en","CPI (cancelled) · 2026-03-05"],
  ["postponed","2026-03-05","2026-03-08","zh","消费价格（已推迟） · 2026-03-05 – 2026-03-08"],
  ["provisional","2026-03","2026-04","en","CPI (provisional) · 2026-03 – 2026-04"],
] as const)("retains calendar status %s and the precision of each endpoint", (status,date,end_date,locale,expected) => {
  const output = {data:{items:[{kind:"macro",status,date,end_date,evidence_id:"ev_cpi",title_en:"CPI",title_zh:"消费价格"}]}};
  for (const field of ["date","status", ...(end_date ? ["end_date"] : [])]) {
    const [line] = verifiedLines(fieldReply("upcoming_events",output,"/data/items/0/" + field),locale);
    expect(line?.text).toBe(expected);
  }
});
