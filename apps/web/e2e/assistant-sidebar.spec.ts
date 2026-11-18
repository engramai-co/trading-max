import historicalEvents from "../tests/fixtures/historical-events.json";
import historicalDividend from "../tests/fixtures/historical-dividend.json";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backendFixture } from "../tests/loading/fixtures";
import { ASSISTANT_NAME } from "../workspace/assistant-settings";

function line(section: string, source: string, tool: string, zh: string, en: string) {
  return {section, zh, en, evidence: { source, tool, arguments: {range:"1W", ticker:"SYNT"}, evidenceId:"ev_example" }};
}
async function fixtures(page: Page, ready = true) {
  await page.route("**/api/backend/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/profile")) return route.fulfill({json:{...backendFixture(url) as object,assistantEnabled:ready}});
    if (url.pathname.endsWith("/assistant/status")) return route.fulfill({json:{ ready, code: ready ? null : "assistant_disabled" }});
    if (url.pathname.endsWith("/reading")) return route.fulfill({contentType:"application/x-ndjson", body:JSON.stringify({type:"result",reading:{
      role: url.pathname.includes("weekly") ? "weekly" : "daily", version:"synthetic", asOf:"2026-01-30T20:00:00Z",
      lines:[line("market","market","compare_benchmarks","组合与 VOO 同期回报接近。","The portfolio tracked VOO over the shared period."),
        line("portfolio","account","period_performance","本期净盈亏 £18.40。","Period net P&L was £18.40."),
        line("events","review","recent_decisions","本周有一笔 SYNT 买入记录。","One SYNT purchase was recorded this week."),
        {...line("next","calendar","upcoming_events","2026-02-03 · JP · 消费者价格","2026-02-03 · JP · Consumer prices"),
          evidence:{source:"calendar",tool:"upcoming_events",evidenceId:"ev_cal",arguments:{
            date:"2026-02-03",instant:"2026-02-04T08:30:00+09:00",url:"https://example.org/calendar"}},
          related:[
            {...line("next","financials","upcoming_events","2026-02-04 – 2026-02-06 · SYNT 预计财报","2026-02-04 – 2026-02-06 · SYNT estimated earnings"),
              evidence:{source:"financials",tool:"upcoming_events",evidenceId:"ev_earnings",arguments:{snapshotId:"saved",eventId:"ev_window",date:"2026-02-04",endDate:"2026-02-06",event:"earningsWindow",holdingTicker:"SYNT"}}},
            {...line("next","disclosure","upcoming_events","2026-02-09 · SYNT 除息","2026-02-09 · SYNT ex-dividend"),
              evidence:{source:"disclosure",tool:"upcoming_events",evidenceId:"ev_ex",arguments:{snapshotId:"saved",eventId:"ev_ex",date:"2026-02-09",event:"exDividend",holdingTicker:"SYNT"}}},
          ]}],
    }})+"\n"});
    if (url.pathname.endsWith("/assistant/chat")) {
      const {scope, range, snapshotId} = route.request().postDataJSON().context;
      const chunks = [{type:"start", messageId:"a1"}, {type:"start-step"},
        {type:"tool-input-available",toolCallId:"p",toolName:"period_performance",input:{}},
        {type:"tool-output-available",toolCallId:"p",output:{evidence_id:"ev_period",status:"partial",scope,snapshot_id:snapshotId,bound_arguments:{scope,range,snapshotId},data:{period_pnl_gbp:21.5,window_start:"2026-11-12",window_end:"2026-11-13",coverage:"partial"}}},
        {type:"text-start",id:"t1"},
        {type:"text-delta",id:"t1",delta:"{{/data/period_pnl_gbp}} [ev_period]\n{{cash-flows}} [inference]"},{type:"text-end",id:"t1"}, {type:"finish-step"}, {type:"finish",finishReason:"stop"}];
      return route.fulfill({headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},body:chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n"});
    }
    if (url.pathname.endsWith("/conversations")) return route.fulfill({json:[]});
    const json = backendFixture(url);
    return route.fulfill({status:json === undefined ? 404:200, json:json??{}});
  });
  await page.route("**/api/logos/**", route => route.abort());
}
test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Requires an isolated web build.");
test("disabled entry explains consent and links to Settings", async ({ page }, info) => {
  await fixtures(page, false);
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.getByRole("link")).toHaveAttribute("href", "/settings?tab=assistant");
  await expect(panel).toContainText("设置");
  await expect(panel.getByRole("link")).toBeInViewport();
  await expect(panel).toHaveCSS("position","fixed");
  await expect(page.locator(".mx-digest")).toHaveCount(0);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-disabled-settings-hint.png")});
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
test("explicit follow-up keeps its scope, conversation and draft", async ({ page }, info) => {
  await fixtures(page);
  await page.goto("/");
  const digest = page.locator(".mx-digest");
  await digest.locator("[aria-expanded]").click();
  const question = digest.locator(".mx-reading-actions button").first();
  const wording = await question.innerText();
  await question.click();
  const input = page.locator(".mx-assistant-composer textarea");
  await expect(input).toHaveValue(wording);
  const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
  await input.press("Enter");
  const request = await sent;
  const body = request.postDataJSON();
  expect(body.context).toMatchObject({page:"overview",role:"daily",scope:"broker_total"});
  expect(body.messages).toHaveLength(1);
  await expect(page.locator(".mx-turn-assistant")).toContainText("本期净盈亏 £21.50");
  const liveReply = page.locator("#mx-assistant-panel [aria-live=polite]");
  await expect(liveReply).toHaveCount(1);
  await expect(liveReply).toContainText("本期净盈亏 £21.50");
  await expect(liveReply).toContainText("2026-11-12 – 2026-11-13");
  const moneyLink = page.locator(".mx-turn-assistant").getByRole("link", {name:"账户"});
  await expect(moneyLink).toHaveAttribute("href", "/analytics?view=money&range=1D&moneyFrom=2026-11-12&moneyTo=2026-11-13&snapshotId=synthetic&evidence=period_performance");
  await expect(liveReply).toContainText("覆盖不完整");
  const visible = await page.locator(".mx-turn-assistant .mx-reading-line").allInnerTexts();
  await expect(liveReply).toHaveText(visible.join(" "));
  expect(new URL(request.url()).searchParams.get("format")).toBe("references");
  await expect(page.locator(".mx-turn-assistant")).not.toContainText("{{");
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-verified-figure.png")});
  await input.fill("Draft retained");
  if (info.project.name === "desktop") {
    const pageBox = await page.locator("#main-content").boundingBox();
    const panelBox = await page.locator("#mx-assistant-panel").boundingBox();
    expect(pageBox!.x + pageBox!.width).toBeLessThanOrEqual(panelBox!.x);
    await page.locator(".mx-sidebar a[href='/holdings']").click();
    await expect(input).toHaveValue("Draft retained");
    await expect(page.locator(".mx-assistant-scope")).toContainText("持仓");
  }
  await page.keyboard.press("Control+j");
  await expect(input).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(input).toHaveValue("Draft retained");
  await expect(page.locator(".mx-turn-assistant")).toContainText("本期净盈亏 £21.50");
});
for (const language of ["zh", "en"]) for (const theme of ["light", "dark"] as const) {
  test("brief and sidebar " + language + " " + theme, async ({ page }, info) => {
    if (info.project.name === "mobile") await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.addInitScript(lang => {
      localStorage.setItem("trading_max-locale",lang);
      localStorage.setItem("trading_max-time-zone","Asia/Tokyo");
    },language);
    await fixtures(page);
    await page.goto("/");
    const digest = page.locator(".mx-digest");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","false");
    await expect(digest.locator(".mx-digest-summary")).toContainText("£18.40");
    await digest.locator("[aria-expanded]").click();
    await expect(digest.locator(".mx-reading-line")).toHaveCount(4);
    const comingUp = digest.locator(".mx-digest-grid > div").last();
    await expect(comingUp).toContainText(language === "zh" ? /2026年2月4日.*08:30/ : /4 Feb 2026.*08:30/);
    await expect(comingUp.getByRole("link")).toHaveText(language === "zh" ? ["日历", "财报", "披露"] : ["Calendar", "Financials", "Disclosure"]);
    await expect(comingUp.getByRole("link").first()).toHaveAttribute("href","https://example.org/calendar");
    await expect(comingUp).toContainText("2026-02-04 – 2026-02-06");
    const shots = process.env.ASSISTANT_SCREENSHOTS;
    await digest.evaluate(el => el.scrollIntoView({block:"center",behavior:"instant"}));
    if (shots) await page.screenshot({path:join(shots, info.project.name+"-"+language+"-"+theme+"-brief.png")});
    await page.locator("[data-assistant-trigger]").click();
    const panel = page.locator("#mx-assistant-panel");
    await expect(panel.locator("textarea")).toHaveAttribute("placeholder", language === "zh" ? "给 "+ASSISTANT_NAME+" 发消息…" : "Message "+ASSISTANT_NAME+"…");
    await expect(panel.locator(".mx-assistant-questions button")).toHaveCount(3);
    expect((await new AxeBuilder({page}).include("#mx-assistant-panel").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (shots) await page.screenshot({path:join(shots, info.project.name+"-"+language+"-"+theme+"-sidebar.png")});
  });
}
test("saved history loads and deletes a conversation", async ({page}) => {
  await fixtures(page);
  let erased = false;
  await page.route("**/api/backend/assistant/conversations", route => route.fulfill({json: erased ? [] : [{id:"prior",title:"Synthetic prior turn"}]}));
  await page.route("**/api/backend/assistant/conversations/prior", route => {
    if (route.request().method() === "DELETE") {
      erased = true;
      return route.fulfill({ status:204, body:"" });
    }
    return route.fulfill({json:{id:"prior",messages:[{id:"u",role:"user",parts:[{type:"text",text:"Historical question"}]}]}});
  });
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  await page.getByRole("button", {name:"历史对话"}).click();
  await expect(page.getByRole("button", {name:"返回对话"})).toBeFocused();
  await page.getByRole("button", {name:"Synthetic prior turn", exact:true}).click();
  await expect(page.locator(".mx-turn-user")).toHaveText("Historical question");
  await page.getByRole("button", {name:"历史对话"}).click();
  await page.getByRole("button", {name:"删除对话 · Synthetic prior turn"}).click();
  await expect(page.locator("#mx-assistant-panel")).toContainText("暂无已保存的对话。");
  await page.getByRole("button", {name:"返回对话"}).click();
  await expect(page.locator(".mx-turn-user")).toHaveCount(0);
});
test("stopping a turn restores its question and evidence points to the selected page", async ({page}) => {
  await fixtures(page);
  let finish: () => void = () => {};
  const hold = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/api/backend/assistant/chat*", async route => {
    await hold;
    await route.abort().catch(() => undefined);
  });
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const input = page.getByRole("textbox", {name:"消息"});
  try {
    await input.fill("Show this period");
    await input.press("Enter");
    await page.getByRole("button", {name:"停止",exact:true}).click();
    await expect(input).toHaveValue("Show this period");
  } finally { finish(); }
  await page.getByRole("button", {name:"关闭侧栏"}).click();
  const digest = page.locator(".mx-digest");
  await digest.locator("[aria-expanded]").click();
  await digest.getByRole("link", {name:"账户",exact:true}).click();
  await expect(page).toHaveURL(/analytics.*evidence=period_performance/);
  await expect(page.locator("[data-assistant-evidence]")).toBeVisible();
});

test("weekly follow-ups retain the reading context after navigation and stop", async ({page}, info) => {
  await fixtures(page);
  await page.goto("/?scope=invest&range=3M");
  const digest = page.locator(".mx-digest");
  await digest.getByRole("button", {name:"周报",exact:true}).click();
  await digest.locator("[aria-expanded]").click();
  await digest.locator(".mx-reading-actions button").first().click();
  const input = page.locator(".mx-assistant-composer textarea");
  const draft = await input.inputValue();
  if (info.project.name === "desktop") {
    await page.locator(".mx-sidebar a[href='/holdings']").click();
  } else {
    await page.locator("#mx-assistant-panel").getByRole("button", {name:"关闭侧栏"}).click();
    await page.locator("a[href='/holdings']:visible").first().click();
    await page.locator("[data-assistant-trigger]").click();
  }
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/backend/assistant/chat*", async route => {await held; await route.abort().catch(() => {});});
  try {
    for (let i = 0; i < 2; i++) {
      const sent = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
      await input.press("Enter");
      expect((await sent).postDataJSON().context).toMatchObject({role:"weekly",page:"overview",scope:"broker_total",range:"1W",snapshotId:"synthetic",object:{benchmark:"VOO"}});
      await page.getByRole("button",{name:"停止", exact:true}).click();
      await expect(input).toHaveValue(draft);
    }
  } finally {release();}
});
test("an open Overview discovers a scheduled reading without starting a model run", async ({page}) => {
  await page.clock.install();
  await fixtures(page);
  let reads = 0;
  await page.route("**/api/backend/assistant/roles/daily/reading", route => {
    expect(route.request().postDataJSON()).toMatchObject({latest:true,cachedOnly:true});
    reads++;
    return route.fulfill({contentType:"application/x-ndjson",body:JSON.stringify({type:"result",reading:{role:"daily",version:"revision-"+reads,asOf:"2026-01-30T20:00:00Z",lines:[line("portfolio","account","period_performance","修订 "+reads,"Revision "+reads)]}})+"\n"});
  });
  await page.goto("/");
  await expect(page.locator(".mx-digest-summary")).toHaveText("修订 1");
  await page.clock.fastForward(65_000);
  await expect(page.locator(".mx-digest-summary")).toHaveText(/修订 [2-9]/);
});
test("uncited or invented chat evidence stays out of the transcript and announcement", async ({page}) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await fixtures(page);
  const chunks = [{type:"start",messageId:"bad"}, {type:"text-start",id:"t"}, {type:"text-delta",id:"t",delta:"Invented fact.\nAnother claim [ev_missing]"}, {type:"text-end",id:"t"}, {type:"finish",finishReason:"stop"}];
  await page.route("**/api/backend/assistant/chat*", route => route.fulfill({headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},body:chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n"}));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  await page.locator(".mx-assistant-questions button").first().click();
  const notice = "This reply could not be verified.";
  await expect(page.locator(".mx-turn-assistant")).toHaveText(notice);
  await expect(page.locator("#mx-assistant-panel [aria-live=polite]")).toHaveText(notice);
  await expect(page.locator("#mx-assistant-panel")).not.toContainText("Invented fact");
});

test("cited money and ex-dividend dates open their published evidence", async ({page}) => {
  await fixtures(page);
  await page.route("**/api/backend/dashboard/history?**", route => {
    const url = new URL(route.request().url());
    const data = backendFixture(url) as Record<string,unknown>;
    return route.fulfill({json:{...data,runId:url.searchParams.get("runId")}});
  });
  const history = page.waitForRequest(r => r.url().includes("/dashboard/history?") && new URL(r.url()).searchParams.get("runId") === "older");
  await page.goto("/analytics?view=money&range=1W&moneyFrom=2026-01-26&moneyTo=2026-01-30&snapshotId=older&evidence=period_performance");
  expect(new URL((await history).url()).searchParams.get("range")).toBe("1W");
  await expect(page.locator(".mx-money-summary[data-assistant-evidence]")).toBeVisible();
  await page.goto("/research?ticker=SYNT&view=overview&event=exDividend&date=2026-11-28&evidence=read_research_lens");
  await expect(page.locator("[data-reading-event]")).toContainText("引用的数据版本或事件暂不可用");
});

test("keyboard Back from History restores focus inside the tablet sidebar", async ({page}, info) => {
  await page.setViewportSize({width:1000,height:800});
  await fixtures(page);
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const history = page.getByRole("button",{name:"历史对话"});
  await history.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"返回对话"})).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(history).toBeFocused();
  if (info.project.name === "desktop" && process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,"history-back-focus.png")});
});
test("neither chat nor its live region repeats a false amount with a genuine citation", async ({page}, info) => {
  await fixtures(page);
  const chunks = [{type:"start",messageId:"wrong"}, {type:"start-step"},
    {type:"tool-input-available",toolCallId:"p",toolName:"period_performance",input:{args:{scope:"broker_total",range:"1W"}}},
    {type:"tool-output-available",toolCallId:"p",output:{evidence_id:"ev_period",status:"partial",data:{period_pnl_gbp:21.5,currency:"GBP",coverage:"partial"}}},
    {type:"text-start",id:"t"},{type:"text-delta",id:"t",delta:"Net P&L was £9,999,999 with complete coverage [ev_period]\n{{other-drivers}} [inference]"},
    {type:"text-end",id:"t"},{type:"finish-step"},{type:"finish",finishReason:"stop"}];
  await page.route("**/api/backend/assistant/chat*", route => route.fulfill({headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
    body:chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n"}));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  await page.locator(".mx-assistant-questions button").first().click();
  await expect(page.locator(".mx-turn-assistant")).toContainText("无法核实");
  await expect(page.locator("#mx-assistant-panel")).not.toContainText("9,999,999");
  await expect(page.locator("#mx-assistant-panel [aria-live=polite]")).toHaveText("无法核实这次回复。");
  if (info.project.name === "desktop" && process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,"false-figure-withheld.png")});
});

for (const locale of ["zh", "en"] as const) {
  test("freshness replies name the cited datasets in " + locale, async ({page}, info) => {
    await page.addInitScript(lang => localStorage.setItem("trading_max-locale", lang), locale);
    await fixtures(page);
    const chunks = [
      {type:"start", messageId:"freshness"}, {type:"start-step"},
      {type:"tool-input-available", toolCallId:"f", toolName:"data_freshness", input:{args:{domain:"research", scope:"invest", ticker:"SYNT"}}},
      {type:"tool-output-available", toolCallId:"f", output:{evidence_id:"ev_fresh", status:"ok", scope:"invest", data:{
        ticker:"SYNT", items:[{dataset:"technical", state:"stale", as_of:"2026-11-01"}, {dataset:"earnings", state:"missing", as_of:null}],
      }}},
      {type:"text-start", id:"t"}, {type:"text-delta", id:"t", delta:"{{/data/items/0/state}} [ev_fresh]\n{{/data/items/1/state}} [ev_fresh]"},
      {type:"text-end", id:"t"}, {type:"finish-step"}, {type:"finish", finishReason:"stop"},
    ];
    await page.route("**/api/backend/assistant/chat*", route => route.fulfill({
      headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
      body:chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n",
    }));
    await page.goto("/");
    await page.locator("[data-assistant-trigger]").click();
    const input = page.locator(".mx-assistant-composer textarea");
    await input.fill(locale === "zh" ? "SYNT 的哪些数据需要更新？" : "Which SYNT datasets need an update?");
    await input.press("Enter");
    const rows = page.locator(".mx-turn-assistant .mx-reading-line");
    await expect(rows.nth(0)).toContainText(locale === "zh" ? "技术指标 · 已过时" : "Technical data · Stale");
    await expect(rows.nth(1)).toContainText(locale === "zh" ? "业绩数据 · 缺失" : "Earnings data · Missing");
    await expect(page.locator("#mx-assistant-panel [aria-live=polite]")).toHaveText((await rows.allInnerTexts()).join(" "));
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS, info.project.name+"-"+locale+"-freshness.png")});
  });
}

test("a saved benchmark citation reopens its portfolio and prices and discloses expiry", async ({page}, info) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await fixtures(page);
  const dates = ["2026-02-02", "2026-02-03"];
  let expired = false;
  await page.route("**/api/backend/dashboard/lens/analytics?**", route => {
    const historical = new URL(route.request().url()).searchParams.get("runId") === "old-brief";
    if (historical && expired) return route.fulfill({status:404,json:{detail:"snapshot not found"}});
    const nav = dates.map((date, i) => ({date,isa:100,isaTwr:i * (historical ? 0.02 : 0.09)}));
    const prices = dates.map((date, i) => ({date,close:100 + i * (historical ? 1 : 3)}));
    return route.fulfill({json:{runId: historical ? "old-brief" : "new-brief", nav, benchmarkSeries:{VOO:prices}}});
  });
  await page.route("**/api/backend/assistant/conversations", route => route.fulfill({json:[{id:"old",title:"Saved benchmark"}]}));
  await page.route("**/api/backend/assistant/conversations/old", route => route.fulfill({json:{id:"old",messages:[
    {id:"user",role:"user",parts:[{type:"text",text:"Compare this period"}]},
    {id:"saved",role:"assistant",parts:[
      {type:"dynamic-tool",toolName:"compare_benchmarks",toolCallId:"c",state:"output-available",input:{},
       output:{status:"ok",scope:"isa",snapshot_id:"old-brief",evidence_id:"ev_old",
          bound_arguments:{scope:"isa",benchmark:"VOO",range:"1W",snapshotId:"old-brief"},
          data:{start:dates[0],end:dates[1],portfolio_twr_fraction:0.02}}},
      {type:"text",text:"{{/data/portfolio_twr_fraction}} [ev_old]\n{{other-drivers}} [inference]"}]},
  ]}}));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  await page.getByRole("button",{name:"Conversation history"}).click();
  await page.getByRole("button",{name:"Saved benchmark",exact:true}).click();
  await expect(page.locator(".mx-turn-assistant")).toContainText("2.00%");
  await page.locator(".mx-turn-assistant").getByRole("link",{name:"Market"}).click();
  const result = page.locator(".mx-return-reading");
  await expect(result).toContainText("+2.00%");
  await expect(result).toContainText("+1.00%");
  await result.scrollIntoViewIfNeeded();
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) await page.screenshot({path:join(shots,info.project.name+"-reopened-benchmark.png")});
  expired = true;
  await page.reload();
  await expect(page.getByText("Cited publication unavailable", {exact:true})).toBeVisible();
  await expect(result).toHaveCount(0);
  if (shots) await page.screenshot({path:join(shots,info.project.name+"-expired-benchmark.png")});
});

test("earnings citations reopen the exact retained row and disclose expiry", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  let expired = false;
  await page.route("**/api/backend/publications/saved/events/upcoming?**", route => route.fulfill(expired
    ? {status:404,json:{detail:"snapshot not found"}} : {json:{
      kind:"earnings",evidence_id:"ev_window",ticker:"SYNT",date:"2026-02-04",end_date:"2026-02-06",title_en:"Estimated earnings",publisher:"Fixture",
    }}));
  await page.goto("/");
  await page.locator(".mx-digest [aria-expanded]").click();
  const link = page.locator(".mx-digest").getByRole("link",{name:"Financials",exact:true}).first();
  await expect(link).toHaveAttribute("href", /snapshotId=saved/);
  await link.click();
  const target = page.locator("[data-reading-event]");
  await expect(target).toContainText("2026-02-04 – 2026-02-06");
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) await page.screenshot({path:join(shots,info.project.name+"-retained-earnings.png")});
  expired = true;
  await page.reload();
  await expect(target).toContainText("Cited publication or event unavailable");
  if (shots) await page.screenshot({path:join(shots,info.project.name+"-expired-earnings.png")});
});

test("disabled Overview matches main's cold request and script counts", async ({browser}, info) => {
  const main = process.env.PLAYWRIGHT_MAIN_BASE_URL;
  test.skip(!main, "Supply the matching main build for the cold-load comparison.");
  async function cold(origin: string, hint: boolean) {
    const page = await browser.newPage({viewport:info.project.use.viewport, serviceWorkers:"block"});
    const requests: string[] = [], scripts: string[] = [];
    const sizes: Promise<number>[] = [];
    await fixtures(page, false);
    page.on("request", request => {
      const {pathname} = new URL(request.url());
      if (pathname.startsWith("/api/")) requests.push(pathname);
    });
    page.on("response", response => {
      if (response.ok() && response.request().resourceType() === "script") {
        scripts.push(new URL(response.url()).pathname);
        sizes.push(response.body().then(body => body.length));
      }
    });
    await page.goto(origin);
    await expect(page.locator(".mx-overview-totals")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const coldScripts = scripts.length;
    if (hint) {
      await page.locator("[data-assistant-trigger]").click();
      await expect(page.locator("#mx-assistant-panel a")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect.soft(scripts.slice(coldScripts), "scripts downloaded by the Settings hint").toEqual([]);
    }
    const scriptBytes = (await Promise.all(sizes)).reduce((total,n) => total+n,0);
    await page.close();
    return {requests:requests.sort(), scripts:coldScripts, scriptBytes};
  }
  const baseline = await cold(main!, false);
  const actual = await cold(process.env.PLAYWRIGHT_BASE_URL!, true);
  await info.attach("cold-load-counts",{body:JSON.stringify({baseline,actual}),contentType:"application/json"});
  expect(actual.requests.filter(path => path.startsWith("/api/backend/assistant/"))).toEqual([]);
  expect.soft(actual.requests).toEqual(baseline.requests);
  expect(actual.scripts).toBeLessThanOrEqual(baseline.scripts);
});

test("a calendar follow-up cites its Tokyo release and the published earnings row", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => {
    localStorage.setItem("trading_max-locale","en");
    localStorage.setItem("trading_max-time-zone","Asia/Tokyo");
  });
  const eventRows = [
    {kind:"macro",evidence_id:"ev_prices",title_en:"Consumer prices",status:"cancelled",date:"2026-02-03",instant:"2026-02-03T23:30:00Z",source_url:"https://example.org/calendar"},
    {kind:"macro",evidence_id:"ev_range",title_en:"GDP",status:"provisional",date:"2026-03",end_date:"2026-04",source_url:"https://example.org/gdp"},
    {kind:"earnings",ticker:"SYNT",evidence_id:"ev_report",research_event_id:"report-1",title_en:"Earnings",date:"2026-02-04"},
  ];
  const chunks = [{type:"start",messageId:"calendar"},{type:"start-step"},
    {type:"tool-input-available",toolCallId:"cal",toolName:"upcoming_events",input:{}},
    {type:"tool-output-available",toolCallId:"cal",output:{evidence_id:"ev_results",snapshot_id:"saved",status:"ok",data:{items:eventRows}}},
    {type:"text-start",id:"t"},{type:"text-delta",id:"t",delta:"{{/data/items/0/date}} [ev_results]\n{{/data/items/1/date}} [ev_results]\n{{/data/items/2/date}} [ev_results]"},
    {type:"text-end",id:"t"},{type:"finish-step"},{type:"finish",finishReason:"stop"}];
  await page.route("**/api/backend/assistant/chat*", route => route.fulfill({
    headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
    body:chunks.map(c => "data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n",
  }));
  await page.goto("/");
  const digest = page.locator(".mx-digest");
  await digest.getByRole("button",{name:"Weekly"}).click();
  await digest.locator("[aria-expanded]").click();
  await expect(digest).toContainText(/4 Feb 2026.*08:30/);
  const shots = process.env.ASSISTANT_SCREENSHOTS;
  if (shots) {
    await digest.evaluate(el => el.scrollIntoView({block:"center",behavior:"instant"}));
    await expect(digest.getByText("Coming up", {exact:true})).toBeInViewport();
    await page.screenshot({path:join(shots,info.project.name+"-weekly-calendar.png")});
  }
  await page.locator("[data-assistant-trigger]").click();
  const input = page.locator(".mx-assistant-composer textarea");
  await input.fill("Which release and earnings date are coming up?");
  await input.press("Enter");
  const reply = page.locator(".mx-turn-assistant");
  await expect(reply).toContainText(/Consumer prices \(cancelled\).*4 Feb 2026.*08:30/);
  await expect(reply).toContainText("GDP (provisional) · 2026-03 – 2026-04");
  await expect(reply.getByRole("link",{name:"Calendar"}).first()).toHaveAttribute("href","https://example.org/calendar");
  await expect(reply.getByRole("link",{name:"Financials"})).toHaveAttribute("href",/snapshotId=saved.*calendarEventId=ev_report/);
  if (shots) await page.screenshot({path:join(shots,info.project.name+"-calendar-followup.png")});
});

test("opening a stale session rechecks consent before exposing saved History", async ({page}) => {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
  await fixtures(page);
  let ready = true, checks = 0, historyReads = 0;
  await page.route("**/api/backend/assistant/status", route => {
    checks++;
    return route.fulfill({json:{ready,code:ready ? null : "assistant_disabled"}});
  });
  await page.route("**/api/backend/assistant/conversations", route => {
    historyReads++;
    return route.fulfill({json:[]});
  });
  await page.goto("/");
  await expect(page.locator(".mx-digest")).toBeVisible();
  ready = false;
  await page.clock.setFixedTime(new Date("2026-03-01T12:06:00Z"));
  await page.locator("[data-assistant-trigger]").click();
  await expect(page.locator("#mx-assistant-panel")).toContainText("Enable the assistant", {timeout:3000});
  await expect(page.getByRole("button",{name:"Conversation history"})).toHaveCount(0);
  await expect(page.locator(".mx-assistant-composer")).toHaveCount(0);
  expect(checks).toBeGreaterThan(1);
  expect(historyReads).toBe(0);
});

test("cross-tab withdrawal suspends cached readings and History while the profile refresh is held", async ({page,context}, info) => {
  await context.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await fixtures(page);
  let enabled = true;
  let releaseProfile!: () => void;
  const profileWait = new Promise<void>(resolve => { releaseProfile = resolve; });
  const assistantRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (!enabled && path.startsWith("/api/backend/assistant/")) assistantRequests.push(path);
  });
  const settings = {enabled:true,revision:1,route:"openai/model-a",acceptedConsentRevision:2,consentRevision:2,acceptedDestination:"https://example.org/v1",
    acceptedAt:"2026-01-01",backgroundBriefsEnabled:false,shareValuationAssumptions:false,providers:[],integrations:[]};
  await page.route("**/api/backend/profile", async route => {
    if (!enabled) await profileWait;
    await route.fulfill({json:{accountLabels:{},assistantEnabled:enabled}});
  });
  await page.route("**/api/backend/assistant/conversations", route => route.fulfill({json:[{id:"saved",title:"Saved weekly follow-up"}]}));
  await page.route("**/api/backend/assistant/status", route => route.fulfill({json:{ready:enabled,code:enabled ? null : "assistant_disabled"}}));
  await page.goto("/");
  const digest = page.locator(".mx-digest");
  await expect(digest).toContainText("Period net P&L was £18.40.");
  await page.locator("[data-assistant-trigger]").click();
  await page.getByRole("button",{name:"Conversation history"}).click();
  const panel = page.locator("#mx-assistant-panel");
  const saved = panel.getByRole("button", {name:"Saved weekly follow-up", exact:true});
  const close = panel.getByRole("button", {name:"Close sidebar"});
  await expect(saved).toBeVisible();
  await saved.focus();
  const other = await context.newPage();
  await fixtures(other);
  await other.route("**/api/backend/settings/assistant", route => {
    if (route.request().method() === "PUT") {
      enabled = false;
      return route.fulfill({json:{...settings,enabled:false,revision:2,acceptedConsentRevision:null,acceptedAt:null}});
    }
    return route.fulfill({json:settings});
  });
  await other.goto("/settings?tab=assistant");
  const refreshing = page.waitForRequest(request => !enabled && new URL(request.url()).pathname === "/api/backend/profile");
  try {
    await other.getByRole("button",{name:"Withdraw consent"}).click();
    await refreshing;
    await page.bringToFront();
    await expect.soft(assistantRequests, "assistant requests before profile confirmation").toEqual([]);
    await expect(panel.getByText("Checking connection…")).toBeVisible({timeout:1500});
    await expect(digest).toHaveCount(0);
    await expect(saved).toBeHidden();
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    expect(assistantRequests).toEqual([]);

    releaseProfile();
    await expect(panel.getByRole("link", {name:"Open Settings"})).toBeVisible();
    await expect(close).toBeFocused();
    await expect(digest).toHaveCount(0);
    await expect(panel.getByText("Saved weekly follow-up")).toHaveCount(0);
    expect(assistantRequests).toEqual([]);
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-withdrawn-consent.png")});
  } finally {
    releaseProfile();
    await other.close();
  }
});

for (const recovery of ["automatic retry", "focus after retry exhaustion"] as const) test(
  "a newer consent signal keeps the draft private until profile recovery: " + recovery, async ({page,context}, info) => {
  await fixtures(page);
  await page.addInitScript(() => {
    localStorage.setItem("trading_max-locale","en");
    // Observe the actual AbortSignals handed to fetch while both responses are held.
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const stream = url.pathname.endsWith("/assistant/chat") ? "chat" :
        url.pathname.endsWith("/roles/weekly/reading") ? "reading" : null;
      if (stream) (init?.signal ?? (input instanceof Request ? input.signal : null))?.addEventListener("abort", () => {
        document.documentElement.setAttribute("data-aborted-" + stream, "");
      }, {once:true});
      return fetch(input, init);
    };
  });
  let changed = false;
  const requests: string[] = [];
  page.on("request", req => {
    const path = new URL(req.url()).pathname;
    if (changed && path.startsWith("/api/backend/assistant/")) requests.push(path);
  });
  const profiles: ((status:number) => void)[] = [];
  await page.route("**/api/backend/profile", async route => {
    const status = changed ? await new Promise<number>(resolve => profiles.push(resolve)) : 200;
    await route.fulfill({status, json:{accountLabels:{},assistantEnabled:true}});
  });
  let releaseStreams!: () => void;
  const hold = new Promise<void>(resolve => { releaseStreams = resolve; });
  await page.route(/\/assistant\/(chat\?|roles\/weekly\/reading)/, async route => {
    await hold;
    await route.abort().catch(() => {});
  });
  await page.goto("/");
  const reading = page.waitForRequest(req => req.url().endsWith("/roles/weekly/reading"));
  await page.getByRole("button", {name:"Weekly", exact:true}).click();
  await reading;
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  const draft = panel.getByRole("textbox", {name:"Message"});
  await draft.fill("Start the chat");
  const chat = page.waitForRequest(req => new URL(req.url()).pathname.endsWith("/assistant/chat"));
  await draft.press("Enter");
  await chat;
  await draft.fill("Keep this unsent question");
  const other = await context.newPage();
  await other.goto("/favicon.ico");
  const signal = (revision:string) => other.evaluate(value => localStorage.setItem("trading_max-assistant-settings-revision",value),revision);
  try {
    changed = true;
    await signal("first");
    await expect.poll(() => profiles.length).toBe(1);
    for (const stream of ["chat","reading"]) await expect(page.locator("html")).toHaveAttribute("data-aborted-" + stream, "");
    await expect(panel.getByText("Checking connection…")).toBeVisible();
    await expect(page.locator(".mx-digest")).toHaveCount(0);
    await signal("second");
    await expect.poll(() => profiles.length).toBe(2);
    profiles[0](200);
    await page.bringToFront();
    profiles[1](503);
    await expect.poll(() => profiles.length).toBe(3);
    await expect(draft).toBeHidden();
    const form = panel.locator("form.mx-assistant-composer");
    await form.evaluate(form => (form as HTMLFormElement).requestSubmit());
    expect(requests).toEqual([]);
    if (recovery === "focus after retry exhaustion") {
      profiles[2](503);
      await expect(panel.getByRole("link", {name:"Open Settings"})).toBeVisible();
      await expect(draft).toBeHidden();
      await form.evaluate(form => (form as HTMLFormElement).requestSubmit());
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => profiles.length).toBe(4);
      expect(requests).toEqual([]);
      profiles[3](200);
    } else {
      profiles[2](200);
    }
    await expect(draft).toHaveValue("Keep this unsent question");
    await expect(draft).toBeFocused();
    await page.keyboard.type(" for later");
    await expect(draft).toHaveValue("Keep this unsent question for later");
    expect(requests[0]).toBe("/api/backend/assistant/status");
    const shots = process.env.ASSISTANT_SCREENSHOTS;
    if (shots && recovery === "automatic retry") await page.screenshot({path:join(shots,info.project.name+"-profile-retry-draft.png")});
  } finally {
    releaseStreams();
    for (const resolve of profiles) resolve(200);
    await other.close();
  }
});

test("narrowing the workspace moves outside focus into the assistant dialog", async ({page}, info) => {
  await page.setViewportSize({width:1440, height:900});
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.getByRole("textbox", {name:"Message"})).toBeFocused();
  const skip = page.getByRole("link", {name:"Skip to content"});
  await skip.focus();
  await expect(skip).toBeFocused();

  await page.setViewportSize({width:1100, height:900});
  await expect(panel).toHaveRole("dialog");
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(panel.locator(":focus")).toHaveCount(1);
  await expect(page.locator(".mx-skip")).toHaveJSProperty("inert", true);
  await page.keyboard.press("Tab");
  await expect(panel.locator(":focus")).toHaveCount(1);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-focus-after-narrowing.png")});
});

for (const transition of ["reopening", "delayed overlay activation"] as const) {
  test("typing continues in the draft after " + transition, async ({page}, info) => {
    await fixtures(page);
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
    if (transition === "delayed overlay activation") await page.setViewportSize({width:1440, height:900});
    await page.goto("/");
    await expect(page.locator(".mx-digest")).toBeVisible();
    await page.locator("[data-assistant-trigger]").click();
    const panel = page.locator("#mx-assistant-panel");
    const draft = panel.getByRole("textbox", {name:"Message"});
    await expect(draft).toBeFocused();
    await page.keyboard.type("First");
    await expect(draft).toHaveValue("First");
    if (transition === "reopening") {
      await panel.getByRole("button", {name:"Close sidebar"}).click();
      await expect(page.locator("[data-assistant-trigger]")).toBeFocused();
      await page.keyboard.press("Control+j");
      await expect(draft).toBeVisible();
    } else {
      // Activate the modal keyboard boundary after the composer has received real keystrokes.
      await page.setViewportSize(info.project.name === "mobile" ? {width:390,height:844} : {width:1100,height:900});
      await expect(panel).toHaveRole("dialog");
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));
    await page.keyboard.type(" and second");
    await expect(draft).toHaveValue("First and second");
    const shots = process.env.ASSISTANT_SCREENSHOTS;
    if (shots) await page.screenshot({path:join(shots, info.project.name + "-" + transition.replaceAll(" ", "-") + ".png")});
    if (transition === "delayed overlay activation") {
      await page.keyboard.press("Tab");
      await expect(panel.getByRole("button", {name:"Send"})).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(panel.getByRole("button", {name:"New conversation"})).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(panel.getByRole("button", {name:"Send"})).toBeFocused();
    }
  });
}

test("a passive readiness response preserves every keystroke during typing", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  const draft = panel.getByRole("textbox", {name:"Message"});
  const send = panel.getByRole("button", {name:"Send"});
  await expect(draft).toBeFocused();
  await page.keyboard.type("Continue");
  await expect(draft).toHaveValue("Continue");

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/backend/assistant/status", async route => {
    await held;
    await route.fulfill({json:{ready:true, code:null}});
  });
  const sends: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/assistant/chat")) sends.push(request.url());
  });
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:31Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  try {
    await expect(panel.getByText("Checking connection…")).toBeVisible();
    await page.exposeFunction("releaseReadiness", release);
    await page.evaluate(() => document.addEventListener("keydown", () => {
      void (window as typeof window & {releaseReadiness: () => Promise<void>}).releaseReadiness();
    }, {once:true}));
    await page.keyboard.type("s");
    await expect(panel.getByText("Checking connection…")).toBeHidden();
    await page.keyboard.type(" the check");
    await expect(draft).toHaveValue("Continues the check");
    await expect(send).toBeEnabled();
    await expect(draft).toBeFocused();
    expect(sends).toEqual([]);
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-typing-through-readiness.png")});
  } finally { release(); }
});

test("a passive readiness check leaves focus on the wide workspace", async ({page}) => {
  await page.setViewportSize({width:1440, height:900});
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.getByRole("textbox", {name:"Message"})).toBeFocused();
  const skip = page.getByRole("link", {name:"Skip to content"});
  await skip.focus();
  await expect(skip).toBeFocused();

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/backend/assistant/status", async route => {
    await held;
    await route.fulfill({json:{ready:true, code:null}});
  });
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:31Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const checking = panel.getByText("Checking connection…");
  try {
    await expect(checking).toBeVisible();
    await expect(skip).toBeFocused();
  } finally { release(); }
  await expect(checking).toBeHidden();
  await expect(skip).toBeFocused();
});

for (const outcome of ["draft", "history button", "reopened draft", "Control+j", "Meta+j", "changed settings", "withdrawn"] as const) {
  test("stale consent revalidation keeps panel focus: " + outcome, async ({page}, info) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
    await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
    await fixtures(page);
    await page.goto("/");
    await page.locator("[data-assistant-trigger]").click();
    const panel = page.locator("#mx-assistant-panel");
    const draft = panel.getByRole("textbox", {name:"Message"});
    await draft.click();
    await draft.fill("Keep this draft");
    await expect(draft).toHaveValue("Keep this draft");
    const shots = process.env.ASSISTANT_SCREENSHOTS;
    const control = outcome === "history button" ? panel.getByRole("button", {name:"Conversation history"}) : draft;
    await control.focus();
    await expect(control).toBeFocused();
    const sends: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/assistant/chat")) sends.push(request.url());
    });
    const shortcut = outcome === "Control+j" || outcome === "Meta+j";
    if (shortcut || outcome === "reopened draft") {
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-assistant-trigger]")).toBeFocused();
      if (shortcut) {
        const skip = page.getByRole("link", {name:"Skip to content"});
        await skip.focus();
        await expect(skip).toBeFocused();
      }
    }

    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/backend/assistant/status", async route => {
      await response;
      const ready = outcome !== "withdrawn";
      await route.fulfill({json:{ready,code:ready ? null : "assistant_disabled"}});
    });
    await page.clock.setFixedTime(new Date("2026-03-01T12:00:31Z"));
    if (shortcut) await page.keyboard.press(outcome);
    else if (outcome === "reopened draft") await page.locator("[data-assistant-trigger]").click();
    else if (outcome === "changed settings") await page.evaluate(() => window.dispatchEvent(
      new StorageEvent("storage",{key:"trading_max-assistant-settings-revision",newValue:"2"})));
    else if (outcome === "withdrawn") await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    else await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    try {
      await expect(panel.getByText("Checking connection…")).toBeVisible();
      if (shortcut) await expect.soft(panel.getByRole("button", {name:"Close sidebar"})).toBeFocused({timeout:1000});
      await expect.soft(panel.locator(":focus"), "focus during the check").toHaveCount(1, {timeout:1000});
      if (shots && outcome === "draft") await page.screenshot({path:join(shots,info.project.name + "-checking-focus.png")});
      if (shortcut || outcome === "reopened draft" || outcome === "changed settings") {
        for (const key of ["Tab", "Shift+Tab"]) {
          await page.keyboard.press(key);
          await expect(panel.getByRole("button", {name:"Close sidebar"})).toBeFocused();
        }
      } else {
        await expect(control).toBeFocused();
        if (outcome === "draft") {
          await expect(panel.getByRole("button", {name:"Send"})).toBeDisabled();
          await panel.locator("form").evaluate(form => (form as HTMLFormElement).requestSubmit());
          await page.keyboard.press("Enter");
          await expect(draft).toHaveValue("Keep this draft");
        }
      }
    } finally {
      release();
    }
    expect(sends).toEqual([]);
    if (outcome === "withdrawn") {
      await expect(panel.getByRole("link", {name:"Open Settings"})).toBeVisible();
      await expect(panel.getByRole("button", {name:"Close sidebar"})).toBeFocused();
      await expect(draft).toHaveCount(0);
      if (shots) await page.screenshot({path:join(shots,info.project.name + "-withdrawn-focus.png")});
    } else {
      await expect(control).toBeFocused();
      await expect(draft).toHaveValue("Keep this draft");
      if (shots && outcome === "draft") await page.screenshot({path:join(shots,info.project.name + "-restored-focus.png")});
      await page.keyboard.press("Tab");
      await expect(panel.locator(":focus")).toHaveCount(1);
    }
  });
}

test("a historical dividend in chat reopens its published amount and basis", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  const row = historicalDividend.data.items[0];
  const chunks = [{type:"start",messageId:"dividend"},{type:"start-step"},
    {type:"tool-input-available",toolCallId:"d",toolName:"news_and_events",input:{args:{scope:"invest",ticker:row.ticker,start:row.date,end:row.date}}},
    {type:"tool-output-available",toolCallId:"d",output:historicalDividend},
    {type:"text-start",id:"t"},{type:"text-delta",id:"t",delta:`{{/data/items/0/amount}} [${historicalDividend.evidence_id}]\n{{insufficient-evidence}} [inference]`},
    {type:"text-end",id:"t"},{type:"finish-step"},{type:"finish",finishReason:"stop"}];
  await page.route("**/api/backend/assistant/chat*", route => route.fulfill({
    headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
    body:chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n",
  }));
  await page.route("**/api/backend/publications/**/events/upcoming?**", route => {
    const url = new URL(route.request().url());
    expect(url.pathname).toContain("/publications/" + historicalDividend.snapshot_id + "/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ticker:row.ticker,kind:"dividend",eventId:row.evidence_id});
    return route.fulfill({json:row});
  });
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  await page.locator(".mx-assistant-questions button").first().click();
  const disclosure = page.locator(".mx-turn-assistant").getByRole("link", {name:"Disclosure"});
  await disclosure.click({timeout:3000});
  const target = page.locator("[data-reading-event]");
  await expect(target).toContainText("USD 0.375 per share");
  await expect(target).toContainText("Provider-adjusted per share");
  await expect(target).toContainText(row.date);
  if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-historical-dividend.png")});
});

async function streamHistoricalEventReplies(page: Page, turns: string[][]) {
  const items = historicalEvents.data.items;
  let next = 0;
  await page.route("**/api/backend/assistant/chat*", route => {
    const id = "historical-" + next;
    const text = turns[next++].map(kind =>
      `{{/data/items/${items.findIndex(row => row.kind === kind)}/date}} [${historicalEvents.evidence_id}]`).join("\n");
    const chunks = [{type:"start",messageId:id},{type:"start-step"},
      {type:"tool-input-available",toolCallId:id,toolName:"news_and_events",input:{args:{scope:"invest",start:historicalEvents.data.start,end:historicalEvents.data.end}}},
      {type:"tool-output-available",toolCallId:id,output:historicalEvents},
      {type:"text-start",id},{type:"text-delta",id,delta:text},{type:"text-end",id},
      {type:"finish-step"},{type:"finish",finishReason:"stop"}];
    return route.fulfill({headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
      body:chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n"});
  });
}

test("mixed historical event replies retain their published dates and citations", async ({page}, info) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  const items = historicalEvents.data.items;
  // Each turn selects up to four observations from the same eight-row tool result.
  const turns = [
    ["news", "earnings", "ex_dividend", "dividend"],
    ["earnings", "dividend", "ex_dividend", "dividend_pay"],
    ["news", "rating_change", "filing", "own_trade"],
  ];
  await streamHistoricalEventReplies(page, turns);
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const input = page.getByRole("textbox",{name:"Message"});
  for (const [index,kinds] of turns.entries()) {
    await input.fill(kinds.join(", "));
    await input.press("Enter");
    const reply = page.locator(".mx-turn-assistant").nth(index);
    for (const [i,kind] of kinds.entries()) {
      const row = items.find(item => item.kind === kind)!;
      const line = reply.locator(".mx-reading-line").nth(i);
      await expect(line).toContainText(row.title_en);
      await expect(line).toContainText(row.date);
      const link = line.getByRole("link");
      if (kind === "news" || kind === "filing" || kind === "rating_change") {
        await expect(link).toHaveAttribute("href", row.source_url!);
      } else if (kind === "own_trade") {
        await expect(link).toHaveAttribute("href", /\/review\?account=A/);
      } else {
        const args = new URL((await link.getAttribute("href"))!, page.url()).searchParams;
        expect(Object.fromEntries(args)).toMatchObject({snapshotId:historicalEvents.snapshot_id,
          calendarEventId:row.evidence_id, event:kind === "ex_dividend" ? "exDividend" : kind, ticker:row.ticker});
      }
    }
    if (process.env.ASSISTANT_SCREENSHOTS) await page.screenshot({path:join(process.env.ASSISTANT_SCREENSHOTS,info.project.name+"-historical-dates-"+index+".png")});
  }
});

async function openDraftBeforeStatusCheck(page: Page) {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"));
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  const draft = panel.getByRole("textbox", {name:"Message"});
  await expect(draft).toBeFocused();
  await page.keyboard.type("Continue");
  await expect(draft).toHaveValue("Continue");
  return {panel, draft, send:panel.getByRole("button", {name:"Send"})};
}

async function holdPassiveStatus(page: Page) {
  let release!: (status: number) => void;
  const held = new Promise<number>(resolve => { release = resolve; });
  await page.route("**/api/backend/assistant/status", async route => {
    const status = await held;
    await route.fulfill({status, json:status === 200 ? {ready:true,code:null} : {detail:"Temporarily unavailable"}});
  }, {times:1});
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:31Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#mx-assistant-panel").getByText("Checking connection…")).toBeVisible();
  return release;
}

test("a passive status failure preserves the draft until readiness recovers", async ({page}) => {
  const {panel, draft, send} = await openDraftBeforeStatusCheck(page);
  const posts: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/assistant/chat")) posts.push(request.postDataJSON().messages[0].parts[0].text);
  });
  const fail = await holdPassiveStatus(page);
  await expect(send).toBeDisabled();
  await page.keyboard.type("s through recovery");
  await expect(draft).toHaveValue("Continues through recovery");
  fail(503);
  await expect(panel.getByRole("link", {name:"Open Settings"})).toBeVisible();
  await expect(draft).toBeHidden();
  const retry = await holdPassiveStatus(page);
  // Exercise the actual submission handler even if the composer is hidden during confirmation.
  await panel.locator("form").evaluateAll(forms => forms.forEach(form => (form as HTMLFormElement).requestSubmit()));
  expect(posts).toEqual([]);
  retry(200);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Continues through recovery");
  await expect(send).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect.poll(() => posts).toEqual(["Continues through recovery"]);
});
test("narrowing restores Message when the remembered Send button is disabled", async ({page}) => {
  await page.setViewportSize({width:1440, height:900});
  const {panel, draft, send} = await openDraftBeforeStatusCheck(page);
  await send.focus();
  await expect(send).toBeFocused();
  const skip = page.getByRole("link", {name:"Skip to content"});
  await skip.focus();
  await expect(skip).toBeFocused();

  const release = await holdPassiveStatus(page);
  try {
    await expect(send).toBeDisabled();
    await expect(skip).toBeFocused();
    await page.setViewportSize({width:1100, height:900});
    await expect(panel).toHaveRole("dialog");
    await expect(draft).toBeFocused();
    await page.keyboard.type(" typing");
    await expect(draft).toHaveValue("Continue typing");
  } finally { release(200); }
});

test("a Broker citation opens the retained decision and reports expiry", async ({page}) => {
  await fixtures(page);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await streamHistoricalEventReplies(page, [["own_trade", "earnings"]]);
  const trade = historicalEvents.data.items.find(row => row.kind === "own_trade")!;
  const snapshot = historicalEvents.snapshot_id;
  let state: "available" | "missing" | "expired" = "available";
  const requests: (string | null)[] = [];
  await page.route("**/api/backend/dashboard/lens/account-analysis?**", route => {
    const run = new URL(route.request().url()).searchParams.get("runId");
    requests.push(run);
    if (run === snapshot && state === "expired") return route.fulfill({status:404, json:{detail:"snapshot not found"}});
    const decision = {date:trade.date,ticker:trade.ticker,side:trade.side,kind:"B",amountGbp:125,
      name:run === snapshot ? "Original synthetic fill" : "Replacement synthetic fill",observedDays:2,events:[]};
    return route.fulfill({json:{runId:run ?? "newer",accounts:[],holdings:[],nav:[],brokerAsOf:trade.date,
      selectedAccountDecisions:{status:"available",asOf:trade.date,decisions:state === "missing" ? [] : [decision]}}});
  });
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const draft = page.getByRole("textbox", {name:"Message"});
  await expect(draft).toBeFocused();
  await page.keyboard.type("When was the purchase?");
  await page.getByRole("button", {name:"Send"}).click();
  await page.locator(".mx-turn-assistant").getByRole("link", {name:"Broker"}).click();
  await expect(page).toHaveURL(url => url.pathname === "/review" && url.searchParams.get("snapshotId") === snapshot);
  await expect.poll(() => requests[0]).toBe(snapshot);
  await expect(page.locator(".mx-decision-focus")).toContainText("Original synthetic fill");
  for (const outcome of ["missing", "expired"] as const) {
    state = outcome;
    await page.reload();
    await expect(page.getByText(outcome === "expired" ? "Cited publication unavailable" : "Cited decision unavailable")).toBeVisible();
    await expect(page.locator(".mx-decision-focus")).toHaveCount(0);
  }
  expect(requests.every(run => run === snapshot)).toBe(true);
});
