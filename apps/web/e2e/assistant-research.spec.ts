import earlyClose from "../tests/fixtures/market-early-close.json";
import listingRefusal from "../tests/fixtures/listing-prices-unavailable.json";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backendFixture } from "../tests/loading/fixtures";

const snapshot = "synthetic-loading", series = "a".repeat(20), day = "2026-01-22";
const base = "/api/backend/research/SYNT";
const fixtures = async (page: Page, ready = true, earningsGate?: Promise<void>, selectedDate = day) => {
  const readings: string[] = [];
  await page.route("**/api/backend/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith("/profile")) return route.fulfill({json:{...backendFixture(url) as object,assistantEnabled:ready}});
    if (path.endsWith("/assistant/status")) return route.fulfill({json: {ready}});
    if (path.includes("/assistant/key-moments/")) {
      expect(url.searchParams.get("published_series_id")).toBe(series);
      const start = url.searchParams.get("start")!, end = url.searchParams.get("end")!;
      return route.fulfill({json:{data:{published_series_id:series, start, end, items: [selectedDate].filter(d => start <= d && d <= end).map(date => ({date}))}}});
    }
    if (path.endsWith("/reading")) {
      const role = path.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      readings.push(role);
      if (role === "earnings-brief") await earningsGate;
      if (role === "earnings-brief") expect(body).toMatchObject({cachedOnly:true, latest:true});
      else expect(body).toMatchObject({snapshotId:snapshot, context:{ticker:"SYNT", published_series_id:series}});
      if (role === "key-moment") expect(body.context.date).toBe(selectedDate);
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

for (const language of ["zh","en"]) for (const theme of ["light","dark"] as const) {
  test(`research cards ${language} ${theme}`, async ({page,isMobile},info) => {
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.addInitScript(lang => localStorage.setItem("trading_max-locale",lang),language);
    const reads = await fixtures(page);
    const shot = async (name:string) => {
      const folder=process.env.ASSISTANT_SCREENSHOTS;
      if (folder) await page.screenshot({scale:"css",path:join(folder,[info.project.name,language,theme,name].join("-")+".png")});
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
    expect(reads.filter(r=>r==="key-moment")).toHaveLength(1);
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
  await expect(page.getByText("Price history is unavailable for this listing.")).toBeVisible({timeout:4000});
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
  await expect(page.getByText("Price history is unavailable for this listing.")).toBeVisible();
  await expect(page.locator(".mx-track-moment, .mx-key-marker")).toHaveCount(0);
  expect(candidates).toEqual([]);
});

test("reselecting a day after zoom keeps the new chart window in chat", async ({page,isMobile}) => {
  const selected = "2025-12-18";
  await fixtures(page,true,undefined,selected);
  await page.addInitScript(() => localStorage.setItem("trading_max-locale","en"));
  await page.route("**/api/backend/assistant/chat*", route => route.fulfill({
    headers:{"content-type":"text/event-stream","x-vercel-ai-ui-message-stream":"v1"},
    body:'data: {"type":"start","messageId":"one"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
  }));
  await page.goto("/research?ticker=SYNT&view=technical");
  const track = page.locator(".mx-track-moment");
  const card = page.locator(isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading");
  const composer = page.locator(".mx-assistant-composer textarea");
  async function submit() {
    const next = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/assistant/chat"));
    await composer.fill("Read this selection"); await composer.press("Enter");
    return (await next).postDataJSON().context.object;
  }
  await track.click();
  await card.locator(".mx-reading-actions button").first().click();
  const first = await submit();
  await page.getByRole("button",{name:"Close sidebar"}).click();
  if (await card.isVisible()) await card.getByRole("button").first().click();
  const newWindow = page.waitForRequest(r => r.url().includes("/assistant/key-moments/"));
  await page.getByRole("button",{name:"Zoom in"}).click();
  const query = new URL((await newWindow).url()).searchParams;
  await track.click();
  await expect(card.locator(".mx-reading-line")).toHaveCount(2);
  if (isMobile) await card.getByRole("button").first().click();
  await page.locator("[data-assistant-trigger]").click();
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
