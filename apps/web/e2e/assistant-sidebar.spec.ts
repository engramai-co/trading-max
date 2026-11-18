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
      const chunks = [{type:"start", messageId:"a1"}, {type:"start-step"}, {type:"text-start",id:"t1"},
        {type:"text-delta",id:"t1",delta:"A synthetic reply."},{type:"text-end",id:"t1"}, {type:"finish-step"}, {type:"finish",finishReason:"stop"}];
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
  const sent = page.waitForRequest(r => r.url().endsWith("/assistant/chat"));
  await input.press("Enter");
  const body = (await sent).postDataJSON();
  expect(body.context).toMatchObject({page:"overview",role:"daily",scope:"broker_total"});
  expect(body.messages).toHaveLength(1);
  await expect(page.locator(".mx-turn-assistant")).toContainText("A synthetic reply.");
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
  await expect(page.locator(".mx-turn-assistant")).toContainText("A synthetic reply.");
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
  await page.route("**/api/backend/assistant/chat", async route => {
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
