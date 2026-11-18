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
    if (url.pathname.endsWith("/assistant/status")) return route.fulfill({json:{ ready, code: ready ? null : "assistant_disabled" }});
    if (url.pathname.endsWith("/reading")) return route.fulfill({contentType:"application/x-ndjson", body:JSON.stringify({type:"result",reading:{
      role: url.pathname.includes("weekly") ? "weekly" : "daily", version:"synthetic", asOf:"2026-01-30T20:00:00Z",
      lines:[line("market","market","compare_benchmarks","组合与 VOO 同期回报接近。","The portfolio tracked VOO over the shared period."),
        line("portfolio","account","period_performance","本期净盈亏 £18.40。","Period net P&L was £18.40."),
        line("events","review","recent_decisions","本周有一笔 SYNT 买入记录。","One SYNT purchase was recorded this week."),
        line("next","financials","read_research_lens","2 月 4 日 · SYNT 财报","4 February · SYNT earnings")],
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
test("disabled entry explains consent and links to Settings", async ({ page }) => {
  await fixtures(page, false);
  await page.goto("/");
  await page.locator("[data-assistant-trigger]").click();
  const panel = page.locator("#mx-assistant-panel");
  await expect(panel.getByRole("link")).toHaveAttribute("href", "/settings?tab=assistant");
  await expect(panel).toContainText("设置");
  await expect(page.locator(".mx-digest")).toHaveCount(0);
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
    await page.addInitScript(lang => localStorage.setItem("trading_max-locale",lang),language);
    await fixtures(page);
    await page.goto("/");
    const digest = page.locator(".mx-digest");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","false");
    await expect(digest.locator(".mx-digest-summary")).toContainText("£18.40");
    await digest.locator("[aria-expanded]").click();
    await expect(digest.locator(".mx-reading-line")).toHaveCount(4);
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
  await page.route("**/api/backend/research/SYNT/lens/overview?**", route => {
    const data = backendFixture(new URL(route.request().url())) as Record<string,unknown>;
    return route.fulfill({json:{...data,fundamentals:{earningsCalendar:{"Ex-Dividend Date":"2026-11-28"}}}});
  });
  await page.goto("/research?ticker=SYNT&view=overview&event=exDividend&date=2026-11-28&evidence=read_research_lens");
  await expect(page.locator("[data-reading-event]")).toContainText("2026-11-28");
  await expect(page.locator("[data-reading-event]")).toContainText("除息日期");
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
