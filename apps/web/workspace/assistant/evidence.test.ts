import pageOutputs from "./page-figures.fixture.json";
import { describe, expect, it } from "vitest";
import { dividendAmount } from "@/lib/dividend-disclosure";
import earlyClose from "../../tests/fixtures/market-early-close.json";
import historicalEvents from "../../tests/fixtures/historical-events.json";
import historicalDividend from "../../tests/fixtures/historical-dividend.json";
import { verifiedLines } from "./chat-reply";
import { chatContext, displayTurns, evidenceHref, messageEvidence, observationText, readableDates, sourceLabel } from "./evidence";
import type { UIMessage } from "ai";

describe("dates in readings and replies", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  it("writes ISO days and instants as the workspace dates them", () => {
    expect(readableDates("2026-11-18，板块涨跌 +1.20%。", "zh", "Europe/London", now)).toBe("11月18日，板块涨跌 +1.20%。");
    expect(readableDates("2026-08-12 – 2026-11-10, return +4.0%", "en", "Europe/London", now)).toBe("12 Aug – 10 Nov, return +4.0%");
    expect(readableDates("Weight as of 2025-12-31.", "en", "Europe/London", now)).toBe("Weight as of 31 Dec 2025.");
    expect(readableDates("Published 2026-11-18T23:55:00Z", "en", "Asia/Tokyo", now)).toBe("Published 19 Nov 08:55");
  });
  it("leaves identifiers and other digit runs alone", () => {
    for (const text of ["price_bar:SYNT:2026-11-05-close", "ref 12026-11-05", "2026-11-05:open"]) {
      expect(readableDates(text, "en", "Europe/London", now)).toBe(text);
    }
  });
});

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
    expect(chatContext("holdings", "", "Europe/London", { page: "holdings", scope: "invest" })).toEqual({page:"holdings",scope:"invest",timezone:"Europe/London"});
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
  const id = output.evidence_id ?? "ev_local";
  return {id:"answer",role:"assistant",parts:[
    {type:"dynamic-tool",toolName,toolCallId:"tool",state:"output-available",input:{},
      output:{status:"ok",evidence_id:"ev_local", ...output}},
    {type:"text",text:`{{${pointer}}} [${id}]\n{{insufficient-evidence}} [inference]`},
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
it.each(["list_holdings", "position_detail"])("%s dates a quote only from the position observation", tool => {
  const quote = {ticker:"SYN", scope:"isa", price_currency:"GBP", current_price:7};
  const output = {sources:[{as_of:"2026-08-02T07:00:00Z"}], data:{items:[
    {...quote, observed_at:null},
    {...quote, scope:"invest", observed_at:"2026-08-01T19:00:00Z"},
  ]}};
  const undated = fieldReply(tool, output, "/data/items/0/current_price");
  expect(verifiedLines(undated)[0].text).toBe("SYN · ISA · Unit price £7.0000 · Time unavailable");
  expect(verifiedLines(undated, "zh")[0].text).toBe("SYN · ISA · 单位价格 £7.0000 · 时间未提供");
  const dated = fieldReply(tool, output, "/data/items/1/current_price");
  expect(verifiedLines(dated)[0].text).toMatch(/SYN · Invest · Unit price £7\.0000 · .*20:00$/);
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

it("keeps the selected research lens, object and evidence destination", () => {
  const evidence = { evidenceId: "ev_reading", source: "market" as const, tool: "price_key_moments",
    arguments: { ticker: "SYNT.L", date: "2026-02-03", lens: "technical" } };
  const link = new URL(evidenceHref(evidence)!, "https://example.invalid");
  expect(Object.fromEntries(link.searchParams)).toMatchObject({ ticker: "SYNT.L", view: "technical", eventDate: "2026-02-03", interval: "1d", unavailable:"1" });
  expect(chatContext("research", "scope=broker_total", "Europe/London", undefined, { ticker: "^TEST", lens: "technical" }))
    .toMatchObject({ page: "research", ticker: "^TEST", lens: "technical", scope: "broker_total" });
  const story = { ...evidence, tool: "research_headline", source: "publisher" as const, arguments: {ticker:"SYNT",url:"https://example.invalid/news"} };
  expect(evidenceHref(story)).toBe(story.arguments.url);
  // An unsafe publisher address leaves the source word without a link.
  expect(evidenceHref({...story, arguments:{...story.arguments,url:"javascript:alert(1)"}}) ?? "").not.toMatch(/^javascript:/);
});

describe("page readings in the sidebar", () => {
  it.each([
    ["selected_money","/data/pnl",["ISA","80.00","Cash-flow-adjusted net P&L"]],
    ["exposure_benchmark","/data/weight",["MSCI ACWI (SSAC)","61.00%","2026-02-02"]],
    ["market_sector","/data/contribution",["Information Technology","MSCI World","0.30 pp","2026-02-03"]],
    ["global_map","/data/markets/0/move",["US","-1.00%","2026-02-03"]],
    ["selected_daily","/data/window_benchmarks/VOO",["VOO","GBP","adjusted prices"]],
    ["selected_exposure","/data/current/weight_fraction",["United States","100.00%","2026-02-03"]],
    ["selected_fx","/data/fx_effect_gbp",["ISA","Held-share currency effect","34.00"]],
    ["sector_headline","/data/items/0/title_en",["Headline","Synthetic issuer update"]],
    ["update_issue","/data/failed_stages/0/en",["Failed stage","Fundamentals"]],
    ["update_issue","/data/attempts",["Recorded attempts","2"]],
    ["update_issue","/data/finished_at",["Update ended","17:00"]],
    ["daily_returns","/data/worst_day/return_fraction",["Lowest observed daily return","-7.27%","2026-02-02","2026-02-03"]],
    ["daily_returns","/data/window_benchmarks/VOO",["VOO","GBP","adjusted prices","+8.00%"]],
  ] as const)("renders the captured %s field %s", (tool, pointer, fragments) => {
    const output = {...pageOutputs[tool], evidence_id:"ev_local"};
    const [line] = verifiedLines(fieldReply(tool,output,pointer));
    for(const fragment of fragments) expect(line.text).toContain(fragment);
    expect(line.evidence?.arguments).toMatchObject({metric:pointer,snapshotId:"synthetic-figures"});
    expect(verifiedLines(fieldReply(tool,output,pointer),"zh")[0].text).not.toBe(line.text);
  });
  it("withholds a closed market value, wrong unit and unpublished benchmark",()=>{
    for (const [tool,pointer,output] of [
      ["global_map","/data/markets/0/move",{...pageOutputs.global_map,data:{...pageOutputs.global_map.data,markets:[{...pageOutputs.global_map.data.markets[0],not_open:true}]}}],
      ["selected_money","/data/pnl",{...pageOutputs.selected_money,data:{...pageOutputs.selected_money.data,currency:"USD"}}],
      ["daily_returns","/data/window_benchmarks/QQQ",pageOutputs.daily_returns],
    ] as const) {
      expect(verifiedLines(fieldReply(tool,{...output,evidence_id:"ev_local"},pointer))).toEqual([]);
    }
  });
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
  // Research links name the listing before the section.
  expect(opened.search).toMatch(/ticker=TEST\.L&.*analystView=/);
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

it("links an index observation to the retained chart, date and recorded event", () => {
  const args = {ticker:"^SYNT",index_id:"example",published_series_id:"a".repeat(20),snapshotId:"older",start:"2026-01-01",
    end:"2026-01-30",date:"2026-01-15",eventId:"report",lens:"technical"};
  const link = new URL(evidenceHref({source:"market", evidenceId:"ev_test",tool:"price_key_moments",arguments:args})!, "http://localhost");
  expect(Object.fromEntries(link.searchParams)).toMatchObject({snapshotId:"older",series:args.published_series_id,eventDate:args.date,eventId:"report",index:"example"});
});

it.each(["earnings","dividend","ex_dividend","dividend_pay","rating_change","macro"])("renders and cites the selected %s event", kind => {
  const supply = {kind,title_en:"Published record",title_zh:"已发布记录",date:"2026-01-15",ticker:kind === "macro" ? null : "TEST",
    source_url:"https://example.invalid/release",reference:"specific",evidence_id:"ev_row",publisher:"Source",status:"scheduled"};
  const reply = fieldReply(kind === "macro" ? "upcoming_events" : "news_and_events",{snapshot_id:"older",data:{items:[supply]}},"/data/items/0/title_en");
  const [line] = verifiedLines(reply);
  expect(line?.text).toContain("Published record");
  expect(line?.text).toContain("2026-01-15");
  expect(line?.evidence?.arguments).toMatchObject({eventId:"ev_row",snapshotId:"older"});
});

it("resolves the saved event identity when the same retained result is presented in a different order", async () => {
  const {researchFigure} = await import("./research-figures");
  const row = {kind:"earnings",ticker:"TEST",title_zh:"财报",date:"2026-02-01"};
  const observation = {status:"ok",scope:"isa",snapshot_id:"older",data:{items:[
    {...row,title_en:"Other earnings",evidence_id:"ev_other"},
    {...row,title_en:"Selected earnings",evidence_id:"ev_selected"},
  ]}};
  const cited = {tool:"news_and_events",source:"financials" as const,evidenceId:"ev_result",arguments:{eventId:"ev_selected"}};
  expect(researchFigure(cited,observation,"/data/items/0/title_en","en","Europe/London")?.text).toContain("Selected earnings");
});

it("qualifies partial daily returns with observed intervals and dates the largest move", () => {
  const output = {status:"partial",quality:{issues:["daily_twr_missing"]},data:{
    window_start:"2026-01-01",window_end:"2026-01-08",window_twr_fraction:0.155,
    largest_move:{from_date:"2026-01-05",date:"2026-01-06",return_fraction:0.3},
    observed_intervals:2,total_intervals:4,
  }};
  expect(verifiedLines(fieldReply("selected_daily",output,"/data/window_twr_fraction"))[0].text).toContain("2 of 4 intervals");
  const largest = verifiedLines(fieldReply("selected_daily",output,"/data/largest_move/return_fraction"))[0].text;
  for(const part of ["Largest observed daily move","+30.00%","2026-01-05 – 2026-01-06","2 of 4 intervals"]) expect(largest).toContain(part);
});
it("links the market observation and the immutable holding selection",()=>{
  const params=(tool:string,args:Record<string,string>)=>new URL(evidenceHref({tool,source:"exposure",evidenceId:"ev_test",arguments:args})!,"https://example.org").searchParams;
  const market=params("global_map",{market:"jp",observed:"2026-01-30T12:00:00Z",snapshotId:"older"});
  expect(Object.fromEntries(market)).toMatchObject({market:"global",region:"jp",observed:"2026-01-30T12:00:00Z",snapshotId:"older"});
  expect(Object.fromEntries(params("selected_exposure",{dimension:"company",category:"DUP",entityId:"issuer-2",snapshotId:"older"}))).toMatchObject({entityId:"issuer-2",snapshotId:"older"});
});

it("displays a Tokyo session headline in the reader's time zone", () => {
  const evidence = {tool:"sector_headline",source:"publisher" as const,evidenceId:"ev_news",
    arguments:{instant:"2026-02-02T23:30:00Z",start:"2026-02-03"}};
  const line = {en:"2026-02-03 · TEST headline",zh:"2026-02-03 · TEST 新闻",evidence};
  expect(observationText(line,"en","Asia/Tokyo")).toMatch(/3 Feb 2026.*08:30/);
  expect(observationText(line,"en","Europe/London")).toMatch(/2 Feb 2026.*23:30/);
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

it("reports coverage for the cited metric on a partially observed portfolio",()=>{
  const data={window_start:"2026-01-02",window_end:"2026-01-08",window_twr_fraction:0.155,
    window_benchmarks:{VOO:0.08},benchmark_currency:"USD",benchmark_basis:"auto_adjusted_close",observed_intervals:2,total_intervals:4};
  for(const tool of ["selected_daily","daily_returns"]){
    const output={data,status:"partial",quality:{issues:["daily_twr_missing"]}};
    const benchmark=verifiedLines(fieldReply(tool,output,"/data/window_benchmarks/VOO"),"en")[0].text;
    expect(benchmark).toContain("+8.00%");
    expect(benchmark).toContain("both endpoint prices observed");
    expect(benchmark).not.toMatch(/2 of 4|limited coverage/);
    expect(verifiedLines(fieldReply(tool,output,"/data/window_twr_fraction"),"en")[0].text).toContain("2 of 4 intervals");
  }
});

it("carries the fund observation in both reading and chat weight citations",()=>{
  const args={dimension:"sector",category:"Information Technology",snapshotId:"older",benchmarkSource:"SWDA",benchmarkAsOf:"2026-02-02",benchmarkObservation:"bw_0123456789abcdef"};
  const reading={tool:"exposure_benchmark",source:"exposure" as const,evidenceId:"ev_weight",arguments:args};
  const reply=fieldReply("exposure_benchmark",{snapshot_id:"older",bound_arguments:{dimension:"sector",category:args.category},
    data:{dimension:"sector",weight:0.28,as_of:args.benchmarkAsOf,source:args.benchmarkSource,observation:args.benchmarkObservation}},"/data/weight");
  for(const evidence of [reading,verifiedLines(reply)[0].evidence!]){
    const params=new URL(evidenceHref(evidence)!,"http://localhost").searchParams;
    expect(Object.fromEntries(params)).toMatchObject(args);
  }
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

it.each([
  ["ex_dividend", "exDividend"], ["dividend_pay", "dividend_pay"],
])("opens the exact retained %s disclosure", (kind, event) => {
  const row = {kind, ticker:"SYNT", evidence_id:"ev_published", date:"2026-02-05",
    title_en:"Dividend disclosure", source_url:"https://example.org/current-quote"};
  const [line] = verifiedLines(fieldReply("upcoming_events", {snapshot_id:"saved", data:{items:[row]}}, "/data/items/0/date"));
  expect(line.evidence?.source).toBe("disclosure");
  const url = new URL(evidenceHref(line.evidence!)!, "http://localhost");
  expect(url.pathname).toBe("/research");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    event, evidence:"read_research_lens", snapshotId:"saved", calendarEventId:"ev_published", ticker:"SYNT",
  });
});

it("keeps a saved account event scoped to the original publication", () => {
  const row = {kind:"own_trade",ticker:"TEST",title_en:"Account trade",date:"2026-01-15",evidence_id:"ev_fill"};
  const [line] = verifiedLines(fieldReply("news_and_events",{scope:"isa",snapshot_id:"old",data:{
    items:[row],timezone:"Europe/London",start:row.date,end:row.date}},"/data/items/0/date"));
  expect(line.evidence?.source).toBe("broker");
  expect(Object.fromEntries(new URL(evidenceHref(line.evidence!)!,"http://localhost").searchParams)).toMatchObject({
    snapshotId:"old",eventId:"ev_fill",scope:"isa",event:"own_trade",
  });
});

it("renders the published amount and retained disclosure from news_and_events", () => {
  const row = historicalDividend.data.items[0];
  for (const field of ["date", "amount", "basis"]) {
    const pointer = "/data/items/0/" + field;
    const message = fieldReply("news_and_events", historicalDividend, pointer);
    const [line] = verifiedLines(message);
    expect(line?.text).toContain("SYNT · Dividend · 2026-01-06");
    if (field === "amount") expect(line.text).toContain("USD 0.375 per share");
    if (field === "basis") expect(line.text).toContain("Provider-adjusted per share");
    expect(line.evidence?.source).toBe("disclosure");
    expect(Object.fromEntries(new URL(evidenceHref(line.evidence!)!, "http://localhost").searchParams)).toMatchObject({
      event:"dividend", ticker:row.ticker, snapshotId:historicalDividend.snapshot_id, calendarEventId:row.evidence_id,
    });
  }
});

it("withholds historical amounts with missing currency or units in the reply and its destination", () => {
  const row = historicalDividend.data.items[0];
  for (const changes of [{currency:null},{unit:null}]) {
    const incomplete = {...row,...changes};
    const output = {...historicalDividend, data:{...historicalDividend.data,items:[incomplete]}};
    expect(verifiedLines(fieldReply("news_and_events",output,"/data/items/0/amount"))).toEqual([]);
    expect(dividendAmount(incomplete.amount,incomplete.currency,incomplete.unit,"en")).toBeNull();
  }
});

it("resolves each published historical event date to its source in mixed replies", () => {
  const items = historicalEvents.data.items;
  const expected = [
    ["dividend_pay", "disclosure"], ["news", "publisher"], ["ex_dividend", "disclosure"], ["own_trade", "broker"],
    ["rating_change", "analysts"], ["filing", "disclosure"], ["earnings", "financials"], ["dividend", "disclosure"],
  ];
  expect(items.map(row => row.kind)).toEqual(expected.map(([kind]) => kind));
  for (const offset of [0, 4]) {
    const rows = items.slice(offset, offset + 4);
    const message = fieldReply("news_and_events", historicalEvents, "/data/items/0/date");
    message.parts[1] = {type:"text", text:rows.map((_, i) =>
      `{{/data/items/${offset + i}/date}} [${historicalEvents.evidence_id}]`).join("\n")};
    const lines = verifiedLines(message, "en");
    expect(lines).toHaveLength(rows.length);
    rows.forEach((row, index) => {
      const {text, evidence} = lines[index];
      expect(text).toContain(row.date);
      expect(text).toContain(row.title_en);
      expect(evidence?.source).toBe(expected[offset + index][1]);
      const href = evidenceHref(evidence!);
      if (row.kind === "news" || row.kind === "filing" || row.kind === "rating_change") {
        expect(href).toBe(row.source_url);
        if (row.kind === "news") expect(evidence?.publisher).toBe(row.publisher);
      } else if (row.kind === "own_trade") {
        const url = new URL(href!, "http://localhost");
        expect(url.pathname).toBe("/review");
        expect(Object.fromEntries(url.searchParams)).toEqual({account:"A", decision:"2026-11-25.buy.ALFA", snapshotId:historicalEvents.snapshot_id});
      } else {
        expect(Object.fromEntries(new URL(href!, "http://localhost").searchParams)).toMatchObject({
          event:row.kind === "ex_dividend" ? "exDividend" : row.kind,
          ticker:row.ticker, snapshotId:historicalEvents.snapshot_id, calendarEventId:row.evidence_id,
        });
      }
    });
  }
});

it("preserves the selected market on an early-close source link", () => {
  const {output, arguments:args} = earlyClose;
  const message = fieldReply("upcoming_events", {...output,bound_arguments:args}, "/data/items/0/date");
  const [line] = verifiedLines(message, "en");
  const url = new URL(evidenceHref(line.evidence!)!, "http://localhost");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    market:args.market,eventTicker:args.ticker,eventId:output.data.items[0].evidence_id,snapshotId:output.snapshot_id,
  });
});

it.each([
  ["America/New_York", "2026-11-24T19:30:00-05:00", "2026-11-24", "2026-11-25"],
  ["Europe/London", "2026-11-25T00:30:00Z", "2026-11-25", "2026-11-25"],
  ["Asia/Tokyo", "2026-11-25T23:30:00Z", "2026-11-26", "2026-11-25"],
  ["Asia/Tokyo", "2026-11-28T12:00:00Z", "2026-11-28", "2026-11-27"],
])("keeps the Broker decision identifier on its UTC ledger weekday in %s at %s", (zone, instant, localDay, ledgerDay) => {
  const fill = historicalEvents.data.items.find(row => row.kind === "own_trade")!;
  const output = {...historicalEvents, data:{items:[{...fill, date:instant.slice(0, 10), instant, local_date:localDay}]}};
  const [line] = verifiedLines(fieldReply("news_and_events", output, "/data/items/0/local_date"), "en", zone);
  expect(line.text).toContain(localDay);
  const href = new URL(evidenceHref(line.evidence!)!, "http://localhost");
  expect(href.searchParams.get("decision")).toBe(ledgerDay + ".buy.ALFA");
  expect(href.searchParams.get("snapshotId")).toBe(historicalEvents.snapshot_id);
});

it("withholds Broker links without an investing account and a decision identity", () => {
  const args = {scope:"invest", side:"buy", date:"2026-11-25", ticker:"ALFA", event:"own_trade", eventId:"ev_trade", snapshotId:"original"};
  for (const missing of [{scope:"broker_total"}, {scope:"cfd"}, {side:""}, {date:""}, {ticker:""}, {eventId:""}, {snapshotId:""}]) {
    expect(evidenceHref({tool:"news_and_events", source:"broker", evidenceId:"ev_source", arguments:{...args,...missing}})).toBeNull();
  }
});

it("cites the restated sentence of a company description on the security's overview", () => {
  const evidence = {tool:"company_profile", source:"disclosure" as const, evidenceId:"ev_profile",
    arguments:{ticker:"TEST", lens:"overview", sentence:"1", sentenceId:"6e2b34b5", snapshotId:"saved-run"}};
  expect(evidenceHref(evidence)).toBe(
    "/research?ticker=TEST&sentence=1&sentenceId=6e2b34b5&snapshotId=saved-run&view=overview&evidence=company_profile");
  expect([sourceLabel(evidence, zh => zh), sourceLabel(evidence, (_zh, en) => en)]).toEqual(["披露", "Disclosure"]);
});
