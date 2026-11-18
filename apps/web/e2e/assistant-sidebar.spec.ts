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
    ? {status:404,json:{detail:"snapshot not found"}} : {json:{snapshot_id:"saved",data:{items:[
      {kind:"earnings",evidence_id:"ev_window",ticker:"SYNT",date:"2026-02-04",end_date:"2026-02-06",title_en:"Estimated earnings",publisher:"Fixture"},
    ]}}}));
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
