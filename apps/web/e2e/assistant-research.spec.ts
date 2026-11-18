import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backendFixture } from "../tests/loading/fixtures";

const snapshot = "synthetic-loading", series = "a".repeat(20), day = "2026-01-22";
const base = "/api/backend/research/SYNT";
const fixtures = async (page: Page, ready = true) => {
  const readings: string[] = [];
  await page.route("**/api/backend/**", route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith("/assistant/status")) return route.fulfill({json: {ready}});
    if (path.includes("/assistant/key-moments/")) {
      expect(url.searchParams.get("published_series_id")).toBe(series);
      const start = url.searchParams.get("start")!, end = url.searchParams.get("end")!;
      return route.fulfill({json:{data:{published_series_id:series, start, end, items: [day].filter(d => start <= d && d <= end).map(date => ({date}))}}});
    }
    if (path.endsWith("/reading")) {
      const role = path.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      readings.push(role);
      if (role === "earnings-brief") expect(body).toMatchObject({cachedOnly:true, latest:true});
      else expect(body).toMatchObject({snapshotId:snapshot, context:{ticker:"SYNT", published_series_id:series}});
      if (role === "key-moment") expect(body.context.date).toBe(day);
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
        lines:labels.map(([zh,en,source,tool])=>({zh,en,evidence:{source,tool,evidenceId:"ev_fixture",arguments:{ticker:"SYNT",lens:source==="financials"?"analyst":"technical",date:day}}})),
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
      return route.fulfill({json:{...overview,view:path.split("/").at(-1),analyst:{
        asOf:"2026-01-30",recommendations:[{period:"0m",strongBuy:1,buy:3,hold:2,sell:1,strongSell:0}],
        priceTargets:{median:105,low:90,high:115},earningsEvents:[],
      }}});
    }
    const json = backendFixture(url);
    return route.fulfill({status:json === undefined?404:200,json:json??{}});
  });
  await page.route("**/api/logos/**", route => route.abort());
  return readings;
};
test.skip(!process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"), "Requires a local web build.");

for (const language of ["zh","en"]) for (const theme of ["light","dark"] as const) {
  test(`research cards ${language} ${theme}`, async ({page,isMobile},info) => {
    if (isMobile) await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.addInitScript(lang => localStorage.setItem("trading_max-locale",lang),language);
    const reads = await fixtures(page);
    const shot = async (name:string) => {
      const folder=process.env.ASSISTANT_SCREENSHOTS;
      if (folder) await page.screenshot({path:join(folder,[info.project.name,language,theme,name].join("-")+".png")});
    };
    await page.goto("/research?ticker=SYNT");
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
    expect(reads).not.toContain("key-moment");
    const marker = page.locator(".mx-key-marker");
    if (isMobile) { await expect(marker).toBeHidden(); await track.click(); }
    else { await expect(marker).toHaveCSS("width","18px"); await marker.focus(); await marker.press("Enter"); }
    const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
    await expect(card.locator(".mx-reading-line a")).toHaveCount(2);
    await shot("moment");
    await card.getByRole("button").first().click();
    await expect(card).toHaveCount(0);
    await expect(page.locator(".mx-event-track button").filter({hasText:"B"})).not.toHaveClass(/mx-track-moment/);
    await track.click(); await expect(card.locator(".mx-reading-line")).toHaveCount(2);
    expect(reads.filter(r=>r==="key-moment")).toHaveLength(1);
    await card.locator(".mx-reading-actions button").first().click();
    const composer = page.locator(".mx-assistant-composer textarea");
    await expect(composer).not.toHaveValue("");
    await page.route("**/api/backend/assistant/chat*", route => route.fulfill({status:503, json:{code:"assistant_unavailable"}}));
    const submitted = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/assistant/chat"));
    await composer.press("Enter");
    const request = await submitted;
    expect(new URL(request.url()).searchParams.get("format")).toBe("references");
    const handoff = request.postDataJSON().context;
    expect(handoff).toMatchObject({page:"research", role:"key-moment", scope:"broker_total", ticker:"SYNT", lens:"technical",
      snapshotId:snapshot, object:{ticker:"SYNT", published_series_id:series, date:day}});
    expect(handoff.object.start <= day && day <= handoff.object.end).toBe(true);
    await page.goto("/research?ticker=SYNT&view=analyst");
    const digest=page.locator(".mx-earnings-brief");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","false");
    expect(await digest.evaluate(el=>!!el.parentElement?.querySelector("#research-ratings") && el===el.parentElement.firstElementChild)).toBe(true);
    await digest.locator("[aria-expanded]").click();
    await expect(digest.locator(".mx-reading-line a")).toHaveCount(2);
    await shot("earnings");
    await page.goto("/research?ticker=SYNT&view=fundamentals");
    await expect(digest.locator("[aria-expanded]")).toHaveAttribute("aria-expanded","true");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(isMobile?390:1440);
  });
}
test("disabled research makes no assistant reading or candidate requests",async ({page})=>{
  const reads=await fixtures(page,false);
  const candidates:string[]=[];
  page.on("request",r=>{if(r.url().includes("/assistant/key-moments/")) candidates.push(r.url());});
  await page.goto("/research?ticker=SYNT&view=technical");
  await expect(page.locator(".mx-event-track button").filter({hasText:"B"})).toBeVisible();
  await expect(page.locator(".mx-track-moment")).toHaveCount(0);
  await page.goto("/research?ticker=SYNT&view=analyst");
  await expect(page.locator("#research-ratings")).toBeVisible();
  await expect(page.locator(".mx-digest")).toHaveCount(0);
  expect(reads).toEqual([]); expect(candidates).toEqual([]);
});
