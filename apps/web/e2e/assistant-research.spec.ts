import earlyClose from "../tests/fixtures/market-early-close.json";
import listingRefusal from "../tests/fixtures/listing-prices-unavailable.json";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backendFixture } from "../tests/loading/fixtures";
import { sentenceId } from "../workspace/company-profile";
import type { ResearchLensSnapshot, ResearchShell } from "../lib/types";

const snapshot = "synthetic-loading", series = "a".repeat(20), day = "2026-01-22";
const base = "/api/backend/research/SYNT";
const fixtures = async (page: Page, ready = true, earningsGate?: Promise<void>, selectedDates: string | string[] = day) => {
  const momentDates = typeof selectedDates === "string" ? [selectedDates] : selectedDates;
  const readings: string[] = [];
  await page.route("**/api/backend/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith("/profile")) return route.fulfill({json:{...backendFixture(url) as object,assistantEnabled:ready}});
    if (path.endsWith("/assistant/status")) return route.fulfill({json: {ready}});
    if (path.includes("/assistant/key-moments/")) {
      expect(url.searchParams.get("published_series_id")).toBe(series);
      const start = url.searchParams.get("start")!, end = url.searchParams.get("end")!;
      return route.fulfill({json:{data:{published_series_id:series, start, end, items: momentDates.filter(d => start <= d && d <= end).map(date => ({date}))}}});
    }
    if (path.endsWith("/reading")) {
      const role = path.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      readings.push(role);
      if (role === "earnings-brief") await earningsGate;
      if (role === "earnings-brief") expect(body).toMatchObject({cachedOnly:true, latest:true});
      else expect(body).toMatchObject({snapshotId:snapshot, context:{ticker:"SYNT", published_series_id:series}});
      if (role === "key-moment") expect(momentDates).toContain(body.context.date);
      const labels = role === "earnings-brief" ? [
        ["每股收益为 USD 1.32，预期为 1.26。","EPS was USD 1.32 versus an estimate of 1.26.","financials","research_earnings"],
        ["下季度每股收益一致预期为 USD 1.44。","Consensus EPS for the next quarter was USD 1.44.","analysts","research_earnings"],
      ] : role === "your-position" ? [
        ["最近一笔已核实成交为 1 月 12 日买入。","The last verified buy was on 12 January.","broker","research_position"],
        ["1 月 12 日至 1 月 30 日，收盘价上涨 2.1%。","The closing price rose 2.1% from 12 to 30 January.","market","research_position"],
      ] : [
        ["1 月 22 日收盘上涨 3.2%。","The close rose 3.2% on 22 January.","market","price_key_moments"],
        ["当日已公布季度业绩。","Quarterly results were reported that day.","financials","price_key_moments"],
      ];
      return route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({type:"result",reading:{
        role, snapshotId:snapshot,version:snapshot,asOf:"2026-01-30T20:00:00Z",
        lines:labels.map(([zh,en,source,tool])=>({zh,en,evidence:{source,tool,evidenceId:"ev_fixture",arguments:{ticker:"SYNT",fiscalPeriod:"FY2025 Q4", reportDate:"2026-01-20",lens:source==="financials"?"analyst":"technical",date:day}}})),
      }})+"\n"});
    }
    if (path.endsWith("/prices")) {
      const fixture = backendFixture(new URL(base + "/prices",url)) as {points:{date:string;close:number}[]};
      return route.fulfill({json:{...fixture, snapshotId:snapshot,publishedSeriesId:series,actualInterval:"1d",tradeMarkers:[{
        date:day,ticker:"SYNT",kind:"B",accounts:["invest"],buyOrders:1,sellOrders:0,buyQuantity:2,sellQuantity:0,
      }],points:fixture.points.map(p=>({...p,open:p.close-0.12,low:p.close-0.3,high:p.close+0.2,volume:5000}))}});
    }
    if (path.startsWith(base + "/lens/")) {
      const overview = backendFixture(new URL(base + "/lens/overview",url)) as Record<string,unknown>;
      return route.fulfill({json:{...overview,view:path.split("/").at(-1),earningsBriefEligible:true,analyst:{
        asOf:"2026-01-30",recommendations:[{period:"0m",strongBuy:1,buy:3,hold:2,sell:1,strongSell:0}],
        priceTargets:{median:105,low:90,high:115},earningsEstimate:[{period:"0q",endDate:"2026-03-31",avg:1.44,currency:"USD"}],earningsEvents:[],
      }}});
    }
    const json = backendFixture(url);
    return route.fulfill({status:json === undefined?404:200,json:json??{}});
  });
  await page.route("**/api/logos/**", route => route.abort());
  return readings;
};
test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Requires a local web build.");
test.beforeEach(async ({page,isMobile}) => {
  if (isMobile) await page.setViewportSize({width:390,height:844});
});

test("ordinary Research turns keep the default ticker and visible price window", async ({page}) => {
  await fixtures(page);
  const stored: unknown[] = [];
  await page.route("**/api/backend/assistant/chat*", route => {
    const { context, messages } = route.request().postDataJSON();
    stored.push({ ...messages[0], metadata: { turnContext: { ...context, snapshotId: snapshot } } });
    const chunks = [
      { type: "start", messageId: "reply-" + stored.length },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "{{insufficient-evidence}} [inference]\n{{cash-flows}} [inference]" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop" },
    ];
    return route.fulfill({
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "x-assistant-snapshot-id": snapshot },
      body: chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
    });
  });
  await page.route("**/api/backend/assistant/conversations", route =>
    route.fulfill({ json: [{ id: "research-context", title: "Price windows" }] }));
  await page.route("**/api/backend/assistant/conversations/research-context", route =>
    route.fulfill({ json: { messages: stored } }));

  for (const range of ["3M", "5D"]) {
    await page.goto("/research?view=technical" + (range === "5D" ? "&priceRange=5D" : ""));
    await expect(page.locator(".mx-price-tools").getByText(range, { exact: true })).toBeVisible();
    await page.locator("[data-assistant-trigger]").click();
    const label = `SYNT · 价格 · ${range}`;
    await expect(page.locator(".mx-assistant-scope")).toHaveText(label);
    const message = page.locator(".mx-assistant-composer textarea");
    await message.fill("What moved the price?");
    const sent = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/assistant/chat"));
    await message.press("Enter");
    expect((await sent).postDataJSON().context).toMatchObject({
      page: "research", ticker: "SYNT", lens: "technical", range, snapshotId: snapshot,
    });
    await expect(page.locator(".mx-assistant-turn-context")).toHaveText(label);
    await expect(page.locator(".mx-turn-assistant")).toHaveAttribute("data-turn-status", "completed");
  }

  await page.getByRole("button", { name: "历史对话" }).click();
  await page.getByRole("button", { name: "Price windows", exact: true }).click();
  await expect(page.locator(".mx-assistant-turn-context")).toHaveText(["SYNT · 价格 · 3M", "SYNT · 价格 · 5D"]);
});

test("Research Overview keeps the displayed chart publication during refresh", async ({page}) => {
  await fixtures(page);
  let refreshed = false;
  let releasePrice: () => void = () => {};
  const priceGate = new Promise<void>(resolve => { releasePrice = resolve; });
  const runId = () => refreshed ? "new-research" : snapshot;
  await page.route("**/api/backend/health", route =>
    route.fulfill({json:{service:"trading_max-api", status:"ok", latestRunId:runId()}}));
  await page.route("**/api/backend/research/shell", route => {
    const shell = backendFixture(new URL(route.request().url())) as ResearchShell;
    return route.fulfill({json:{...shell, status:{...shell.status, runId:runId()},
      instruments:shell.instruments.map(item => ({...item, lastRunId:runId()}))}});
  });
  await page.route("**" + base + "/lens/overview?*", route => {
    const lens = backendFixture(new URL(route.request().url())) as ResearchLensSnapshot;
    return route.fulfill({json:{...lens, runId:runId(),
      context:{...lens.context, quote:{...lens.context?.quote, price:refreshed ? 987.65 : 101}}}});
  });
  await page.route("**" + base + "/prices?*", async route => {
    const id = runId();
    if (refreshed) await priceGate;
    const prices = backendFixture(new URL(route.request().url())) as object;
    await route.fulfill({json:{...prices, snapshotId:id}});
  });
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research");
  const chart = page.locator(".mx-price-diagnosis-preview .mx-chart-footer");
  await expect(chart).toBeVisible();
  await page.locator("[data-assistant-trigger]").click();
  const pill = page.locator(".mx-assistant-scope");
  await expect(pill).toHaveText("SYNT · 概览 · 3M");

  try {
    refreshed = true;
    await page.clock.setFixedTime(new Date(Date.now() + 60_000));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator(".mx-security-price")).toContainText("987.65");
    const composer = page.getByRole("textbox", {name:"消息"});
    await composer.fill("What moved this chart?");
    await expect(page.getByRole("button", {name:"发送", exact:true})).toBeEnabled();
    const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    expect((await sent).postDataJSON().context).toMatchObject({
      page:"research", ticker:"SYNT", lens:"overview", range:"3M", snapshotId:snapshot,
    });
  } finally {
    releasePrice();
  }
});

test("a month-only cited event keeps its display and uses Research page context for send and Retry", async ({page}) => {
  await fixtures(page);
  await page.route("**/api/backend/publications/saved/events/upcoming?*", route => route.fulfill({json:{
    kind:"macro", evidence_id:"ev_delayed", ticker:null, date:"2026-12", local_date:"2026-12",
    title_zh:"延期的官方发布", publisher:"ONS",
  }}));
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research?ticker=MARKET&event=macro&eventId=ev_delayed&evidence=upcoming_events&snapshotId=saved");
  await expect(page.locator("[data-reading-event]")).toContainText("2026-12");
  await page.locator("[data-assistant-trigger]").click();
  await expect(page.locator(".mx-assistant-scope")).toHaveText("研究");
  const composer = page.getByRole("textbox", {name:"消息"});
  await composer.fill("Explain this release");
  const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await composer.press("Enter");
  expect((await sent).postDataJSON().context).toEqual({page:"research", timezone:expect.any(String)});
  const retry = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await page.getByRole("button", {name:"重试", exact:true}).click();
  expect((await retry).postDataJSON().context).toEqual({page:"research", timezone:expect.any(String)});
});

test("a cited Research figure sends its retained publication and displayed observation", async ({page}) => {
  await fixtures(page);
  let expired = false;
  await page.route("**/api/backend/research/SYNT/citation?*", route => route.fulfill(expired
    ? {status:404, json:{detail:"cited-research-unavailable"}}
    : {json:{output:{status:"ok", snapshot_id:"historical-result", evidence_id:"ev_report", data:{
      ticker:"SYNT", report:{id:"report-2026", date:"2026-01-20", actual:1.32, currency:"USD"},
    }}}}));
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research?ticker=SYNT&snapshotId=historical-result&evidence=research_earnings&evidenceId=ev_report&field=%2Fdata%2Freport%2Factual&date=2026-01-22");
  await expect(page.locator("#main-content")).toContainText("1.32");
  await page.locator("[data-assistant-trigger]").click();
  const pill = page.locator(".mx-assistant-scope");
  await expect(pill).toContainText("SYNT · 预期 · 财报");
  await expect(pill).toContainText("1月20日");
  const composer = page.getByRole("textbox", {name:"消息"});
  await composer.fill("Explain this result");
  const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await composer.press("Enter");
  expect((await sent).postDataJSON().context).toMatchObject({
    page:"research", ticker:"SYNT", lens:"analyst", snapshotId:"historical-result",
    observation:{kind:"research_earnings", evidenceId:"ev_report", date:"2026-01-20", field:"/data/report/actual"},
  });

  expired = true;
  await page.reload();
  await expect(page.locator("#main-content")).toContainText("引用的研究记录已不可用。");
  await page.locator("[data-assistant-trigger]").click();
  await expect(pill).toHaveText("研究");
});

test("cited calendar follow-ups use the rendered row and its output scope", async ({page}) => {
  await fixtures(page);
  await page.route("**/api/backend/research/OTHER/citation?*", route => route.fulfill({json:{output:{
    status:"ok", snapshot_id:"retained-calendar", evidence_id:"ev_calendar", scope:"isa",
    data:{items:[
      {evidence_id:"ev_wrong", ticker:"OTHER", kind:"earnings", date:"2026-01-06", title_zh:"另一条事件"},
      {evidence_id:"ev_selected", ticker:"SYNT", kind:"earnings", date:"2026-01-20", title_zh:"选中的财报"},
    ]},
  }}}));
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research?ticker=OTHER&snapshotId=retained-calendar&evidence=upcoming_events&evidenceId=ev_calendar&eventId=ev_selected&field=%2Fdata%2Fitems%2F0%2Fdate&scope=invest");
  await expect(page.locator("#main-content")).toContainText("SYNT · 选中的财报 · 2026-01-20");
  await page.locator("[data-assistant-trigger]").click();
  const pill = page.locator(".mx-assistant-scope");
  await expect(pill).toContainText("SYNT");
  await expect(pill).toContainText("ISA");
  const composer = page.getByRole("textbox", {name:"消息"});
  await composer.fill("Explain this event");
  const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await composer.press("Enter");
  expect((await sent).postDataJSON().context).toMatchObject({
    page:"research", ticker:"SYNT", scope:"isa", snapshotId:"retained-calendar",
    observation:{kind:"upcoming_events", evidenceId:"ev_selected", date:"2026-01-20", field:"/data/items/1/date"},
  });
});

test("Research index uses page context unless a key moment is handed off", async ({page,isMobile}) => {
  const id = "marketvector-semiconductor-screened";
  await fixtures(page);
  const index = {id, name:"MarketVector Semiconductor Screened", nameZh:"MarketVector Semiconductor Screened",
    scope:"global", kind:"index", currency:"USD", compiler:"MarketVector", compilerId:id,
    basis:"price", aliases:[], symbol:null, ranges:["3M", "1Y"]};
  await page.route("**/api/backend/indices/catalog", route => route.fulfill({json:[index]}));
  await page.route("**/api/backend/indices/" + id + "/history?*", route => route.fulfill({json:{
    index, currency:"USD", displayInterval:"1d", publishedSeriesId:series, gaps:[],
    points:[{at:"2026-01-15T00:00:00Z", value:100}, {at:day + "T00:00:00Z", value:113},
      {at:"2026-01-30T00:00:00Z", value:120}],
  }}));
  const position = {ticker:"INDEX", index_id:id, published_series_id:series};
  const moment = {...position, start:"2026-01-15", end:"2026-01-30", date:day};
  for (const [role, context] of [["your-position", position], ["key-moment", moment]] as const) {
    await page.route("**/api/backend/assistant/roles/" + role + "/reading", route => {
      expect(route.request().postDataJSON()).toMatchObject({snapshotId:snapshot, context});
      return route.fulfill({contentType:"application/x-ndjson", body:JSON.stringify({type:"result", reading:{
        role, snapshotId:snapshot, version:snapshot, asOf:"2026-01-30T20:00:00Z",
        lines:[{zh:"指数收盘上涨。", en:"The index rose at the close.",
          evidence:{source:"market", tool:role === "key-moment" ? "price_key_moments" : "research_position",
            evidenceId:"ev_index", arguments:{date:day}}}],
      }}) + "\n"});
    });
  }
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  for (const view of ["overview", "price"]) {
    await page.goto("/research?type=index&view=" + view + "&index=" + id);
    await expect(page.locator(".mx-index-research-chart-top")).toContainText(/\+20(?:\.00)?%/);
    const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
    if (view === "price") {
      await page.locator(".mx-track-moment").click();
      await expect(card.locator(".mx-reading-line")).toContainText("指数收盘上涨。");
      await page.keyboard.press("Control+j");
    } else {
      await page.locator("[data-assistant-trigger]").click();
      await expect(page.locator(".mx-assistant-opening .mx-reading-line")).toContainText("指数收盘上涨。");
    }
    await expect(page.locator(".mx-assistant-scope")).toHaveText("研究");
    const composer = page.getByRole("textbox", {name:"消息"});
    await composer.fill("What changed in this index?");
    const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    expect((await sent).postDataJSON().context).toEqual({page:"research", timezone:expect.any(String)});
    if (view === "price") {
      await expect(page.getByRole("button", {name:"重试", exact:true})).toBeVisible();
      await page.keyboard.press("Control+j");
      await card.locator(".mx-reading-actions button").first().click();
      await expect(composer).not.toHaveValue("");
      const handoff = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
      await composer.press("Enter");
      expect((await handoff).postDataJSON().context).toMatchObject({
        page:"research", role:"key-moment", scope:"broker_total", indexId:id, ticker:"INDEX", lens:"technical",
        snapshotId:snapshot, object:moment,
      });
    }
  }
});

for (const language of ["zh","en"]) for (const theme of ["light","dark"] as const) {
  test(`research cards ${language} ${theme}`, async ({page,isMobile},info) => {
    await page.addInitScript((scheme) => localStorage.setItem("mantine-color-scheme-value", scheme), theme);
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.addInitScript(lang => localStorage.setItem("trading_max-locale",lang),language);
    const reads = await fixtures(page);
    const shot = async (name:string) => {
      const folder=process.env.ASSISTANT_SCREENSHOTS;
      if (folder) await page.screenshot({scale:"css",path:join(folder,[info.project.name,language,theme,name].join("-")+".png")});
    };
    await page.goto("/research?ticker=SYNT");
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", theme);
    await expect(page.locator(".mx-tech-preview-grid")).toBeVisible();
    expect(reads).not.toContain("your-position");
    await page.locator("[data-assistant-trigger]").click();
    const panel = page.locator(".mx-assistant-opening");
    await expect(panel.locator(".mx-reading-line a")).toHaveCount(2);
    await expect(panel.locator("h3")).toContainText("SYNT");
    await shot("position");
    await page.goto("/research?ticker=SYNT&view=technical");
    const track = page.locator(".mx-track-moment");
    await expect(track).toHaveCount(1);
    await expect(track.locator("time")).toHaveAttribute("datetime", day);
    await expect(track.locator(".mx-moment-number")).toHaveText("1");
    expect(reads).not.toContain("key-moment");
    const marker = page.locator(".mx-key-marker");
    if (isMobile) { await expect(marker).toBeHidden(); await track.click(); }
    else { await expect(marker).toHaveText("1"); await expect(marker).toHaveCSS("width","18px"); await marker.focus(); await marker.press("Enter"); }
    const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
    await expect(card.locator(".mx-reading-line a")).toHaveCount(2);
    expect((await new AxeBuilder({page}).include(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading").analyze()).violations).toEqual([]);
    await shot("moment");
    await card.getByRole("button").first().click();
    await expect(card).toHaveCount(0);
    await expect(page.locator(".mx-event-track button").filter({hasText:"B"})).not.toHaveClass(/mx-track-moment/);
    await track.click(); await expect(card.locator(".mx-reading-line")).toHaveCount(2);
    // Reopening rechecks the saved reading against its retained publication.
    expect(reads.filter(r=>r==="key-moment")).toHaveLength(2);
    await card.locator(".mx-reading-actions button").first().click();
    const composer = page.locator(".mx-assistant-composer textarea");
    await expect(composer).not.toHaveValue("");
    await page.route("**/api/backend/assistant/chat*", route => {
      const chunks = [{type:"start",messageId:"reply"}, {type:"start-step"},
        {type:"tool-input-available",toolCallId:"moment",toolName:"price_key_moments",input:{}},
        {type:"tool-output-available",toolCallId:"moment",output:{status:"ok",evidence_id:"ev_moment",snapshot_id:snapshot,
          data:{ticker:"SYNT",items:[{date:day,move_fraction:0.032} ]}}},
        {type:"text-start",id:"body"}, {type:"text-delta",id:"body",delta:"{{/data/items/0/move_fraction}} [ev_moment]\n{{attribution}} [inference]"},
        {type:"text-end",id:"body"},{type:"finish-step"},{type:"finish",finishReason:"stop"}];
      return route.fulfill({headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
        body:chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n"});
    });
    const submitted = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    const request = await submitted;
    expect(new URL(request.url()).searchParams.get("format")).toBe("references");
    const handoff = request.postDataJSON().context;
    expect(handoff).toMatchObject({page:"research", role:"key-moment", scope:"broker_total", ticker:"SYNT", lens:"technical",
      snapshotId:snapshot, object:{ticker:"SYNT", published_series_id:series, date:day}});
    expect(handoff.object.start <= day && day <= handoff.object.end).toBe(true);
    await expect(page.locator(".mx-turn-assistant")).toContainText("3.20%");
    await composer.fill("Which sessions followed?");
    const next = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    expect((await next).postDataJSON().context).toEqual(handoff);
    await page.getByRole("button",{name:language === "zh" ? "关闭侧栏" : "Close sidebar"}).click();
    await page.getByRole("tab",{name:language === "zh" ? /预期/ : /Estimates/}).click();
    const digest=page.locator(".mx-earnings-brief");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","false");
    expect(await digest.evaluate(el=>!!el.parentElement?.querySelector("#research-ratings") && el===el.parentElement.firstElementChild)).toBe(true);
    await expect(digest.locator("time")).toHaveAttribute("datetime","2026-01-20");
    await expect(digest).toContainText("FY2025 Q4");
    await shot("earnings-collapsed");
    await digest.locator("[aria-expanded]").click();
    await expect(digest.locator(".mx-reading-line a")).toHaveCount(2);
    expect((await new AxeBuilder({page}).include(".mx-earnings-brief").analyze()).violations).toEqual([]);
    await shot("earnings");
    await page.goto("/research?ticker=SYNT&view=fundamentals");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","true");
    await expect(digest).toBeVisible();
    // Without statements the brief still opens the lens, above its empty state.
    expect(await digest.evaluate(el => el === el.parentElement?.firstElementChild)).toBe(true);
    await shot("financials");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(isMobile?390:1440);
  });
}
test("disabled research makes no assistant reading or candidate requests",async ({page})=>{
  const assets: Promise<string>[] = [];
  page.on("response", r => {
    if (/\.(js|css)(?:\?|$)/.test(r.url()) && r.ok()) assets.push(r.text().catch(() => ""));
  });
  const reads=await fixtures(page,false);
  const candidates:string[]=[];
  page.on("request",r=>{if(r.url().includes("/assistant/")) candidates.push(r.url());});
  await page.goto("/research?ticker=SYNT&view=technical");
  await expect(page.locator(".mx-event-track button").filter({hasText:"B"})).toBeVisible();
  await expect(page.locator(".mx-track-moment")).toHaveCount(0);
  await page.goto("/research?ticker=SYNT&view=analyst");
  await expect(page.locator("#research-ratings")).toBeVisible();
  await expect(page.locator(".mx-digest")).toHaveCount(0);
  expect(reads).toEqual([]); expect(candidates).toEqual([]);
  const downloaded = (await Promise.all(assets)).join("");
  for (const marker of ["Which events were verified that day?", "How did the price change?", ".mx-earnings-brief time"]) expect(downloaded.includes(marker), marker).toBe(false);
});

test("a priced fund opens position and moment readings and omits company earnings", async ({ page, isMobile }) => {
  const reads = await fixtures(page);
  await page.route("**/api/backend/research/shell", route => {
    const shell = backendFixture(new URL(route.request().url())) as { instruments: object[] };
    return route.fulfill({ json: { ...shell, instruments: shell.instruments.map(row => ({ ...row, isFund: true })) } });
  });
  await page.goto("/research?ticker=SYNT");
  await page.locator("[data-assistant-trigger]").click();
  await expect(page.locator(".mx-assistant-opening .mx-reading-line")).toHaveCount(2);
  expect(reads).toContain("your-position");
  await page.goto("/research?ticker=SYNT&view=technical");
  await page.locator(".mx-track-moment").click();
  await expect(page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading")).toBeVisible();
  expect(reads).toContain("key-moment");
  await page.goto("/research?ticker=SYNT&view=fundamentals");
  await expect(page.getByRole("tablist", { name: /研究视角|Research perspectives/ }).getByRole("tab", { selected:true })).toBeVisible();
  await expect(page.locator(".mx-earnings-brief")).toHaveCount(0);
  expect(reads).not.toContain("earnings-brief");
});

test("ratings stay visible and stable while the earnings cache is pending", async ({page}) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads = await fixtures(page,true,gate);
  await page.goto("/research?ticker=SYNT&view=analyst");
  await expect.poll(() => reads.includes("earnings-brief")).toBe(true);
  const ratings = page.locator("#research-ratings");
  await expect(ratings).toBeVisible({timeout:1500});
  const before = await ratings.boundingBox();
  release();
  await expect(page.locator(".mx-earnings-brief")).toBeVisible();
  expect((await ratings.boundingBox())?.y).toBe(before?.y);
});

test("withdrawing consent removes the earnings reservation", async ({page}) => {
  await fixtures(page);
  await page.goto("/research?ticker=SYNT");
  await expect(page.locator(".mx-tech-preview-grid")).toBeVisible();
  await page.getByRole("tab",{name:/预期|Estimates/}).click();
  const ratings = page.locator("#research-ratings");
  const brief = page.locator(".mx-earnings-brief");
  await expect(brief).toBeVisible();
  expect(await brief.evaluate(el => el.parentElement?.firstElementChild === el)).toBe(true);
  await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:false}}));
  await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:false,code:"assistant_disabled"}}));
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage",{key:"trading_max-assistant-settings-revision"})));
  await expect(brief).toHaveCount(0);
  await expect.poll(() => ratings.evaluate(el => el.parentElement?.firstElementChild === el)).toBe(true);
});

for (const lens of ["analyst","technical"]) {
  test("a settings change cancels the pending research read in " + lens, async ({page}) => {
    const endpoint = lens === "analyst" ? "/roles/earnings-brief/reading" : "/assistant/key-moments/";
    await fixtures(page);
    await page.addInitScript(part => {
      const fetchOriginal = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(part)) {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          signal?.addEventListener("abort", () => { document.body.dataset.testReadCancelled = "true"; }, {once:true});
        }
        return fetchOriginal(input, init);
      };
    }, endpoint);
    await page.route(url => url.pathname.includes(endpoint), () => {});
    const pending = page.waitForRequest(req => req.url().includes(endpoint));
    await page.goto("/research?ticker=SYNT&view=" + lens);
    await pending;
    await page.route("**/api/backend/profile", route => route.fulfill({json:{assistantEnabled:false}}));
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage",{key:"trading_max-assistant-settings-revision"})));
    await expect(page.locator("body")).toHaveAttribute("data-test-read-cancelled","true",{timeout:2000});
    await expect(page.locator(".mx-earnings-brief, .mx-track-moment")).toHaveCount(0);
  });
}

test("a later earnings publication preserves the ratings position", async ({page}) => {
  const emptyResponse = page.waitForResponse(response => response.url().endsWith("/earnings-brief/reading"));
  let empty = true;
  await page.clock.install();
  await fixtures(page);
  await page.route("**/api/backend/assistant/roles/earnings-brief/reading", route =>
    empty ? route.fulfill({contentType:"application/x-ndjson",body:'{"type":"empty"}\n'}) : route.fallback());
  await page.goto("/research?ticker=SYNT&view=analyst");
  const ratings = page.locator("#research-ratings");
  await expect(ratings).toBeVisible();
  await (await emptyResponse).finished();
  const before = await ratings.boundingBox();
  empty = false;
  await expect.poll(async () => {
    await page.clock.fastForward(31000);
    return page.locator(".mx-earnings-brief").isVisible();
  }).toBe(true);
  expect((await ratings.boundingBox())?.y).toBe(before?.y);
});

test("each crowded daily marker is reachable at its candle", async ({page,isMobile}) => {
  test.skip(isMobile,"Phones use the event track.");
  await fixtures(page);
  const dates = ["2026-01-20","2026-01-21","2026-01-22"];
  await page.route("**/api/backend/assistant/key-moments/**",route => {
    const q = new URL(route.request().url()).searchParams;
    return route.fulfill({json:{data:{published_series_id:series,start:q.get("start"),end:q.get("end"),items:dates.map(date=>({date}))}}});
  });
  await page.route("**/api/backend/research/SYNT/prices?**",route => {
    const fixture = backendFixture(new URL(base + "/prices",route.request().url())) as Record<string,unknown>;
    const points = Array.from({length:1400},(_,i) => {
      const date = new Date(Date.UTC(2026,0,30)-(1399-i)*86400000).toISOString().slice(0,10);
      const close = 100 + (dates.includes(date) ? 0 : Math.sin(i));
      return {date,close,open:close-.1,high:close+.3,low:close-.3,volume:100};
    });
    return route.fulfill({json:{...fixture,points,availableSessions:points.length,snapshotId:snapshot,publishedSeriesId:series,actualInterval:"1d"}});
  });
  await page.goto("/research?ticker=SYNT&view=technical&priceRange=ALL&interval=1d");
  const markers = page.locator(".mx-key-marker");
  await expect(markers).toHaveCount(3);
  const xy = await markers.evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect(); return [r.x,r.y];
  }));
  expect(Math.max(...xy.map(p=>p[0]))-Math.min(...xy.map(p=>p[0]))).toBeLessThan(18);
  expect(Math.max(...xy.map(p=>p[1]))-Math.min(...xy.map(p=>p[1]))).toBeGreaterThanOrEqual(56);
  const above = await page.locator(".mx-key-stem").evaluateAll(stems => stems.map(stem => {
    const marker = stem.nextElementSibling!.getBoundingClientRect();
    return marker.bottom < stem.getBoundingClientRect().bottom;
  }));
  expect(above).toEqual([true,true,true]);
  for (let i=0;i<3;i++) {
    await markers.nth(i).click({trial:true});
    await expect(markers.nth(i)).toHaveText(String(i+1));
  }
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css",path:join(process.env.ASSISTANT_SCREENSHOTS,"desktop-adjacent-moments.png")});
});

test("a saved index field reopens its exact series and discloses expiry", async ({page},info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  let expired = false;
  await page.route("**/api/backend/research/%5ESYNT/citation?**", route => {
    const query = new URL(route.request().url()).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({index:"example",series,snapshotId:snapshot,date:day,tool:"price_key_moments"});
    return expired ? route.fulfill({status:404,json:{detail:"cited-research-unavailable"}}) :
      route.fulfill({json:{output:{status:"ok",snapshot_id:snapshot,data:{ticker:"^SYNT",items:[{date:day,move_fraction:.041}]}},lines:[]}});
  });
  const url = "/research?" + new URLSearchParams({type:"index",index:"example",ticker:"^SYNT",date:day,start:day,end:day,series,snapshotId:snapshot,
    evidence:"price_key_moments",evidenceId:"ev_saved",field:"/data/items/0/move_fraction"});
  await page.goto(url);
  await expect(page.getByText(/4\.10%/)).toBeVisible();
  expired = true;
  await page.reload();
  await expect(page.getByText("Cited research observation unavailable.")).toBeVisible();
  await expect(page.getByText(/4\.10%/)).toHaveCount(0);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css",path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-expired-research.png")});
});

test("estimate-only brief dates the observation independently of the snapshot", async ({page}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/assistant/roles/earnings-brief/reading", route => {
    const evidence = {tool:"research_earnings",evidenceId:"ev_fixture",source:"analysts",
      arguments:{ticker:"SYNT",snapshotId:snapshot,observedAt:"2026-01-17",lens:"analyst"}};
    return route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({type:"result",
      reading:{role:"earnings-brief",version:snapshot,snapshotId:snapshot,asOf:"2026-01-30T20:00:00Z",
        lines:[{en:"Consensus EPS was USD 1.25.",zh:"每股收益一致预期为 USD 1.25。",evidence}]}})+"\n"});
  });
  await page.goto("/research?ticker=SYNT&view=analyst");
  const date = page.locator(".mx-earnings-brief time");
  await expect(date).toHaveAttribute("datetime","2026-01-17");
  await expect(date).toContainText("Observed");
});

test("missing exchange timing stays visible alongside verified chart events", async ({page}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/assistant/key-moments/**", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({json:{status:"partial",quality:{issues:["listing_calendar_unavailable"]},
      data:{published_series_id:series,start:params.get("start"),end:params.get("end"),items:[{date:day}]}}});
  });
  await page.goto("/research?ticker=SYNT&view=technical");
  await expect(page.locator(".mx-track-moment")).toHaveCount(1);
  await expect(page.getByText("Timed headlines could not be matched to this listing’s trading sessions.")).toBeVisible({timeout:1200});
});

test("unavailable listing prices disclose the listing and withhold its moment controls", async ({page}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  const calls:string[] = [];
  page.on("request", request => {if (request.url().includes("/assistant/key-moments/")) calls.push(request.url());});
  await page.route("**/api/backend/research/SYNT/prices?**",route =>
    route.fulfill({status:404,json:listingRefusal}));
  await page.goto("/research?ticker=SYNT&view=technical");
  await expect(page.getByText("Price history unavailable for this listing")).toBeVisible({timeout:4000});
  await expect(page.locator(".mx-track-moment, .mx-key-marker")).toHaveCount(0);
  expect(calls).toEqual([]);
});


test("a listing refusal clears previously verified bars and moment controls", async ({page}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.goto("/research?ticker=SYNT&view=technical");
  await expect(page.locator(".mx-track-moment")).toHaveCount(1);
  const candidates:string[] = [];
  page.on("request", req => { if (req.url().includes("/assistant/key-moments/")) candidates.push(req.url()); });
  await page.route("**/api/backend/research/SYNT/prices?**", route => route.fulfill({status:404,json:listingRefusal}));
  await page.getByRole("group",{name:"Price range"}).getByRole("button",{name:"1D",exact:true}).click();
  await expect(page.getByText("Price history unavailable for this listing")).toBeVisible();
  await expect(page.locator(".mx-track-moment, .mx-key-marker")).toHaveCount(0);
  expect(candidates).toEqual([]);
});

test("chat follows a newly selected chart day and keeps the zoomed window", async ({page,isMobile}) => {
  const selected = "2025-12-18";
  const otherDay = "2026-01-12";
  await fixtures(page, true, undefined, isMobile ? selected : [selected, otherDay]);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research?ticker=SYNT&view=technical");
  const track = (date: string) => page.locator(".mx-track-moment").filter({has:page.locator(`time[datetime="${date}"]`)});
  const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
  const composer = page.locator(".mx-assistant-composer textarea");
  async function submit() {
    await composer.fill("Read this selection");
    await expect(page.getByRole("button", {name:"Send", exact:true})).toBeEnabled();
    const next = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    return (await next).postDataJSON().context.object;
  }
  await track(selected).click();
  await card.locator(".mx-reading-actions button").first().click();
  const first = await submit();
  expect(first.date).toBe(selected);
  if (!isMobile) {
    await track(otherDay).click();
    await expect(card.locator(".mx-reading-line")).toHaveCount(2);
    await expect(composer).toBeVisible();
    expect(await submit()).toMatchObject({date:otherDay, start:first.start, end:first.end});
    await expect(page).toHaveURL(/\/research\?ticker=SYNT&view=technical$/);
  }
  await page.getByRole("button",{name:"Close sidebar"}).click();
  if (await card.isVisible()) await card.getByRole("button").first().click();
  const newWindow = page.waitForRequest(r => r.url().includes("/assistant/key-moments/"));
  await page.getByRole("button",{name:"Zoom in"}).click();
  const query = new URL((await newWindow).url()).searchParams;
  await track(selected).click();
  await expect(card.locator(".mx-reading-line")).toHaveCount(2);
  if (isMobile) await card.locator(".mx-reading-actions button").first().click();
  else await page.locator("[data-assistant-trigger]").click();
  const second = await submit();
  expect(second).toMatchObject({date:selected,start:query.get("start"),end:query.get("end")});
  expect(second.start).not.toBe(first.start);
});

test("financials summary keeps the earnings brief before its first section", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/research/SYNT/lens/fundamentals?**", route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("detail")).toBe("summary");
    const overview = backendFixture(new URL(base + "/lens/overview",url)) as Record<string,unknown>;
    return route.fulfill({json:{...overview,view:"fundamentals",earningsBriefEligible:true,analyst:null,financials:null,
      fundamentals:{metrics:{marketCap:50000000, employees:180}}}});
  });
  await page.goto("/research?ticker=SYNT&view=fundamentals");
  const brief = page.locator(".mx-earnings-brief");
  await expect(brief).toBeVisible();
  const first = await brief.evaluate(node => ({
    prior: node.previousElementSibling?.className,
    preceding: Array.from(node.parentElement?.children ?? []).map(el => el.className),
    y: Math.round(node.getBoundingClientRect().y),
  }));
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) await page.screenshot({scale:"css",fullPage:true,path:join(shots,info.project.name+"-financials-summary.png")});
  expect(first.preceding[0], JSON.stringify(first)).toBe("mx-earnings-brief");
});

test("Ratings keeps a verified brief ahead of the cached section with no estimate fields", async ({page},info) => {
  let release!: () => void;
  await fixtures(page, true, new Promise<void>(resolve => { release = resolve; }));
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/research/SYNT/lens/analyst?**", route => {
    const url = new URL(route.request().url());
    const overview = backendFixture(new URL(base + "/lens/overview",url)) as Record<string,unknown>;
    return route.fulfill({json:{...overview,view:"analyst",earningsBriefEligible:true,analyst:{asOf:"2026-01-30",
      recommendations:[{period:"0m",strongBuy:1,buy:3,hold:2,sell:1,strongSell:0}],
    }}});
  });
  await page.goto("/research?ticker=SYNT&view=analyst");
  const rating = page.locator("#research-ratings");
  await expect(rating).toBeVisible();
  const before = await rating.boundingBox();
  release();
  const brief = page.locator(".mx-earnings-brief");
  await expect(brief).toBeVisible();
  expect((await rating.boundingBox())?.y).toBe(before?.y);
  const position = await brief.evaluate(node => ({
    before: Boolean(node.compareDocumentPosition(document.querySelector("#research-ratings")!) & Node.DOCUMENT_POSITION_FOLLOWING),
    y: Math.round(node.getBoundingClientRect().y),
  }));
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) await page.screenshot({scale:"css",fullPage:true,path:join(shots,info.project.name+"-ratings-only-brief.png")});
  expect(position.before, JSON.stringify(position)).toBe(true);
});

test("an already-open sidebar receives focus when a chart hands off", async ({page},info) => {
  test.skip(info.project.name!=="desktop","The side-by-side route uses desktop width.");
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.goto("/research?ticker=SYNT&view=technical");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.getByRole("textbox",{name:"Message"})).toBeFocused();
  await page.locator(".mx-track-moment").click();
  const question = page.locator(".mx-anchored-reading .mx-reading-actions button").first();
  await question.focus();
  await page.keyboard.press("Enter");
  const draft = panel.getByRole("textbox",{name:"Message"});
  await expect(draft).toHaveValue("Which events were verified that day?");
  await expect(draft).toBeFocused({timeout:1200});
});

test("an explicit handoff leaves conversation history and focuses the new draft", async ({page,isMobile}) => {
  test.skip(isMobile, "Side-by-side workspace");
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.goto("/research?ticker=SYNT&view=technical");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await panel.getByRole("button",{name:"Conversation history"}).click();
  await expect(panel.getByRole("button",{name:"Back to conversation"})).toBeFocused();
  await page.locator(".mx-track-moment").click();
  await page.locator(".mx-anchored-reading .mx-reading-actions button").first().press("Enter");
  const composer = panel.getByRole("textbox",{name:"Message"});
  await expect(composer).toHaveValue("Which events were verified that day?",{timeout:2000});
  await expect(composer).toBeFocused();
});

test("phone resize with an open research card has one modal and sends focus to MaxAI", async ({page},info) => {
  await page.setViewportSize({width:1440,height:900});
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.goto("/research?ticker=SYNT&view=technical");
  await page.locator(".mx-track-moment").click();
  await page.locator(".mx-anchored-reading .mx-reading-actions button").first().click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.locator("textarea")).not.toHaveValue("");
  const zoom = page.getByRole("button",{name:"Zoom in"});
  await zoom.focus();
  await expect(zoom).toBeFocused();
  await page.setViewportSize({width:390,height:844});
  await expect(panel).toHaveRole("dialog");
  const active = await page.evaluate(() => document.activeElement?.outerHTML.slice(0,165));
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) await page.screenshot({scale:"css",path:join(shots,info.project.name+"-phone-modal-stacking.png")});
  await expect(panel.locator(":focus"),active).toHaveCount(1,{timeout:2000});
  await expect(page.getByRole("dialog")).toHaveCount(1);
});



test("a selected-session early close reopens the bound market and retained row", async ({page}, info) => {
  const {output, arguments:args} = earlyClose;
  const row = output.data.items[0];
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/research/MARKET/citation?**", route => {
    const query = new URL(route.request().url()).searchParams;
    const selected = query.get("market") === args.market && query.get("eventTicker") === args.ticker &&
      query.get("snapshotId") === output.snapshot_id && query.get("eventId") === row.evidence_id &&
      query.get("evidenceId") === output.evidence_id && query.get("timezone") === output.data.timezone;
    return selected ? route.fulfill({json:{output,lines:[]}}) : route.fulfill({status:404,json:{detail:"cited-research-unavailable"}});
  });
  await page.goto("/research?" + new URLSearchParams({ticker:"MARKET",evidence:"upcoming_events",evidenceId:output.evidence_id,
    start:args.start,end:args.end,snapshotId:output.snapshot_id,field:"/data/items/0/date",market:args.market,
    eventTicker:args.ticker,eventId:row.evidence_id,timezone:output.data.timezone}));
  const observation = page.getByText(/XNYS early close.*27 Nov 2026/);
  await expect(observation).toBeVisible();
  expect((await observation.textContent())?.match(/limited coverage/g)).toHaveLength(1);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css",path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-retained-early-close.png")});
});

const description = "Synthetic Issuer Inc. designs and sells synthetic widgets in 12 markets. " +
  "The company also offers Widget Cloud, a subscription service. It was founded in 1999 and is headquartered in Exampleton.";
const restated = [
  ["Synthetic Issuer Inc. 在 12 个市场设计并销售合成小部件。", "Synthetic Issuer Inc. designs and sells synthetic widgets in 12 markets.", "0"],
  ["公司还提供订阅服务 Widget Cloud。", "The company also offers Widget Cloud, a subscription service.", "1"],
  ["公司成立于 1999 年，总部位于 Exampleton。", "It was founded in 1999 and is headquartered in Exampleton.", "2"],
];
const profile = async (page: Page, ready = true) => {
  const reads = await fixtures(page, ready);
  const summaries: unknown[] = [];
  await page.route("**/api/backend/research/SYNT/lens/overview**", route => {
    const overview = backendFixture(new URL(base + "/lens/overview", route.request().url())) as Record<string, unknown>;
    return route.fulfill({json:{...overview, fundamentals:{metrics:{quoteType:"EQUITY", longBusinessSummary:description}}}});
  });
  await page.route("**/api/backend/assistant/roles/company-summary/reading", route => {
    summaries.push(route.request().postDataJSON());
    return route.fulfill({contentType:"application/x-ndjson", body:JSON.stringify({type:"result", reading:{
      role:"company-summary", snapshotId:snapshot, version:"synthetic-profile", asOf:"2026-01-30T20:00:00Z",
      lines:restated.map(([zh, en, sentence]) => ({zh, en, evidence:{source:"disclosure", tool:"company_profile", evidenceId:"ev_profile",
        arguments:{ticker:"SYNT", lens:"overview", sentence, sentenceId:sentenceId(en), snapshotId:snapshot}}})),
    }}) + "\n"});
  });
  return {reads, summaries};
};

test("company summary handoffs keep their context for typed follow-ups until dismissal", async ({page,isMobile}) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await profile(page);
  await page.route("**/api/backend/assistant/chat*", route =>
    route.fulfill({status:429, json:{detail:{code:"provider_rate_limited"}}}));
  await page.goto("/research?ticker=SYNT");
  await page.getByRole("button", {name:"✦ 中文摘要"}).click();
  const reading = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-inline-reading");
  await reading.getByRole("button", {name:"在右栏继续 →"}).click();

  const panel = page.locator("#mx-assistant-panel");
  const composer = panel.getByRole("textbox", {name:"消息"});
  async function submit(text: string) {
    await composer.fill(text);
    const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    const {context} = (await sent).postDataJSON();
    await expect(panel.locator(".mx-turn-assistant").last()).toHaveAttribute("data-turn-status", "rate_limited");
    return context;
  }

  const first = await submit("What products does this company sell?");
  expect(first).toMatchObject({page:"research", role:"company-summary", ticker:"SYNT", lens:"overview",
    snapshotId:snapshot, object:{ticker:"SYNT"}});
  expect(await submit("Where does the company operate?")).toEqual(first);

  await panel.getByRole("button", {name:"关闭侧栏"}).click();
  await page.locator("[data-assistant-trigger]").click();
  expect(await submit("What is visible on this page?")).not.toMatchObject({role:"company-summary"});
});

for (const theme of ["light", "dark"] as const) {
  test(`a Chinese summary restates the company's English description, ${theme}`, async ({page, isMobile}, info) => {
    await page.addInitScript((scheme) => localStorage.setItem("mantine-color-scheme-value", scheme), theme);
    await page.emulateMedia({colorScheme:theme, reducedMotion:"reduce"});
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
    const {reads, summaries} = await profile(page);
    await page.goto("/research?ticker=SYNT");
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", theme);
    const english = page.locator(".mx-business-excerpt");
    await expect(english).toHaveAttribute("lang", "en");
    const trigger = page.getByRole("button", {name:"✦ 中文摘要"});
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Nothing is written until the summary is asked for.
    expect(summaries).toEqual([]);
    if (process.env.ASSISTANT_SCREENSHOTS) {
      await trigger.scrollIntoViewIfNeeded();
      await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, [info.project.name, "zh", theme, "company-summary-offer"].join("-") + ".png")});
    }
    await trigger.click();
    const reading = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-inline-reading");
    await expect(reading.locator(".mx-reading-line")).toHaveCount(3);
    await expect(reading.locator(".mx-reading-line").first()).toContainText("在 12 个市场设计并销售");
    const sources = reading.locator(".mx-reading-source");
    await expect(sources).toHaveText(["披露", "披露", "披露"]);
    await expect(sources.first()).toHaveAttribute("href",
      "/research?ticker=SYNT&sentence=0&sentenceId=cfac2b85&snapshotId=synthetic-loading&view=overview&evidence=company_profile");
    await expect(reading.getByRole("button", {name:"主要产品和服务有哪些？"})).toBeVisible();
    expect(summaries).toEqual([{context:{ticker:"SYNT"}, snapshotId:snapshot}]);
    expect((await new AxeBuilder({page}).include(isMobile ? ".mx-reading-sheet" : ".mx-inline-reading").analyze()).violations).toEqual([]);
    if (!isMobile) await reading.scrollIntoViewIfNeeded();
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, [info.project.name, "zh", theme, "company-summary"].join("-") + ".png")});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(isMobile ? 390 : 1440);
    if (isMobile) {
      await page.getByRole("button", {name:"关闭解读"}).click();
      await expect(reading).toHaveCount(0);
    } else {
      await trigger.click();
      await expect(reading).toHaveCount(0);
    }
    expect(reads).toEqual([]);
  });

  test(`a citation opens the description at its sentence and takes focus, ${theme}`, async ({page, isMobile}, info) => {
    if (isMobile) await page.setViewportSize({width:390, height:844});
    await page.addInitScript((scheme) => localStorage.setItem("mantine-color-scheme-value", scheme), theme);
    await page.emulateMedia({colorScheme:theme, reducedMotion:"reduce"});
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
    await profile(page);
    await page.goto("/research?ticker=SYNT");
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", theme);
    // The two-sentence excerpt does not contain the third sentence.
    await expect(page.locator(".mx-business-excerpt")).not.toContainText("Exampleton");
    await page.getByRole("button", {name:"✦ 中文摘要"}).click();
    const reading = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-inline-reading");
    await reading.locator(".mx-reading-source").nth(2).click();
    await expect(page).toHaveURL(/sentence=2&sentenceId=919014b5&snapshotId=synthetic-loading&view=overview&evidence=company_profile/);
    const sentence = page.locator('[data-profile-sentence="2"]');
    await expect(sentence).toHaveText("It was founded in 1999 and is headquartered in Exampleton.");
    await expect(sentence).toBeFocused();
    await expect(sentence).toHaveAttribute("data-assistant-evidence", "");
    await expect(sentence).toBeInViewport();
    await expect(page.locator(".mx-business-description")).toContainText("12 markets");
    if (isMobile) {
      // Following the citation leaves the sheet, its backdrop and its focus trap.
      await expect(page.locator(".mx-reading-sheet")).toHaveCount(0);
      await expect(page.locator(".tm-drawer-backdrop")).toHaveCount(0);
    }
    expect((await new AxeBuilder({page}).include(".mx-overview-bento").analyze()).violations).toEqual([]);
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, [info.project.name, "zh", theme, "company-summary-citation"].join("-") + ".png")});
  });
}

test("a citation whose sentence has left the description says so in place", async ({page, isMobile}, info) => {
  if (isMobile) await page.setViewportSize({width:390, height:844});
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await profile(page);
  await page.goto("/research?" + new URLSearchParams({ticker:"SYNT", sentence:"2", sentenceId:"00000000", snapshotId:snapshot,
    view:"overview", evidence:"company_profile"}));
  const note = page.getByRole("status").filter({hasText:"引用的句子已不在当前公司介绍中。"});
  await expect(note).toBeVisible();
  await expect(note).toBeFocused();
  await expect(page.locator(".mx-business-excerpt")).toBeVisible();
  await expect(page.locator("[data-profile-sentence]")).toHaveCount(0);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, info.project.name + "-zh-light-citation-missing.png")});
});

test("a citation without a sentence fingerprint opens and outlines the whole description", async ({page, isMobile}) => {
  if (isMobile) await page.setViewportSize({width:390, height:844});
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  await profile(page);
  await page.goto("/research?" + new URLSearchParams({ticker:"SYNT", sentence:"1", snapshotId:snapshot, view:"overview", evidence:"company_profile"}));
  const whole = page.locator(".mx-business-description");
  await expect(whole).toContainText("headquartered in Exampleton");
  await expect(whole).toBeFocused();
  await expect(whole).toHaveAttribute("data-assistant-evidence", "");
  await expect(whole).toHaveCSS("outline-style", "solid");
});

test("the overview offers no summary in English", async ({page}, info) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const {summaries} = await profile(page);
  await page.goto("/research?ticker=SYNT");
  await expect(page.locator(".mx-business-excerpt")).toBeVisible();
  await expect(page.locator(".mx-summary-trigger")).toHaveCount(0);
  expect(summaries).toEqual([]);
  if (process.env.ASSISTANT_SCREENSHOTS) {
    await page.locator(".mx-business-excerpt").scrollIntoViewIfNeeded();
    await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, info.project.name + "-en-light-company-description.png")});
  }
});

test("with MaxAI off the overview is unchanged and loads no summary", async ({page}, info) => {
  const assets: Promise<string>[] = [];
  page.on("response", r => {
    if (/\.(js|css)(?:\?|$)/.test(r.url()) && r.ok()) assets.push(r.text().catch(() => ""));
  });
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "zh"));
  const {summaries} = await profile(page, false);
  const requests: string[] = [];
  page.on("request", r => { if (r.url().includes("/assistant/")) requests.push(r.url()); });
  await page.goto("/research?ticker=SYNT");
  await expect(page.locator(".mx-business-excerpt")).toBeVisible();
  await expect(page.locator(".mx-summary-trigger")).toHaveCount(0);
  expect(summaries).toEqual([]); expect(requests).toEqual([]);
  const downloaded = (await Promise.all(assets)).join("");
  expect(downloaded.includes("Which products and services does it list?")).toBe(false);
  if (process.env.ASSISTANT_SCREENSHOTS) {
    await page.locator(".mx-business-excerpt").scrollIntoViewIfNeeded();
    await page.screenshot({scale:"css", path:join(process.env.ASSISTANT_SCREENSHOTS, info.project.name + "-zh-light-maxai-off.png")});
  }
});

