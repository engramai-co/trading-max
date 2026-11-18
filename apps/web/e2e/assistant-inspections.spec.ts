import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { navNumber, periodReturn, type Scope } from "../lib/portfolio/nav";
import type { DashboardLens } from "../lib/types";
import { portfolioRange } from "../lib/portfolio/history";
import { prepareHistory } from "../lib/portfolio/prepared";
import { backendFixture, historyFixture } from "../tests/loading/fixtures";

const stamp = "2026-01-30T20:00:00Z";
const runId = "synthetic-loading";
const notes = {
  exposure: [
    [
      "配置占已投资资产的 35.00%。",
      "The allocation accounted for 35.00% of invested assets.",
      "exposure",
      "lookthrough_exposure",
    ],
    [
      "MSCI World (SWDA) 的权重为 28.00%。",
      "The MSCI World (SWDA) weight was 28.00%.",
      "exposure",
      "exposure_benchmark",
    ],
  ],
  "market-sector": [
    [
      "有报价的成分中，6 家上涨、1 家持平、3 家下跌。",
      "Among quoted constituents, 6 rose, 1 was flat and 3 fell.",
      "market",
      "market_sector",
    ],
    [
      "当天的板块指数变动为 −0.50%。",
      "The sector index moved −0.50% in the session.",
      "market",
      "market_sector",
    ],
  ],
  diagnosis: [
    [
      "券商持仓明细与账户汇总未对齐。",
      "The broker’s positions did not reconcile to its account summary.",
      "broker",
      "update_issue",
    ],
    [
      "通常是挂单还没成交，或资金刚投进 Pie。",
      "Possible explanations include a pending order or cash recently added to a Pie.",
      "inference",
      "update_issue",
    ],
  ],
} as const;

async function setup(
  page: Page,
  locale: "en" | "zh",
  dark: boolean,
  ready = true,
) {
  await page.emulateMedia({
    colorScheme: dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  await page.addInitScript(
    ({ locale, dark }) => {
      localStorage.setItem("trading_max-locale", locale);
      localStorage.setItem(
        "mantine-color-scheme-value",
        dark ? "dark" : "light",
      );
    },
    { locale, dark },
  );
  const calls: {
    role: string;
    context: Record<string, string>;
    snapshotId?: string;
  }[] = [];
  await page.route("**/api/backend/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/backend", "");
    const fixture = backendFixture(url);
    if (path === "/profile") return route.fulfill({json:{...(fixture as object),assistantEnabled:ready}});
    if (path === "/assistant/status")
      return route.fulfill({
        json: { ready, code: ready ? null : "assistant_disabled" },
      });
    if (path === "/health/details")
      return route.fulfill({
        json: {
          ...(fixture as object),
          refresh: {},
          jobs: [
            {
              jobId: "synthetic-failed",
              scope: "accounts",
              trigger: "nightly",
              skipSync: false,
              status: "failed",
              createdAt: stamp,
              finishedAt: stamp,
              stages: [],
            },
          ],
        },
      });
    if (path === "/dashboard/lens/holdings-lookthrough") {
      const data = fixture as { lookthrough: object };
      return route.fulfill({
        json: {
          ...data,
          lookthrough: {
            ...data.lookthrough,
            investedValueGbp: 10000,
            industryAllocation: [
              {
                industry: "Information Technology",
                allocationPct: 0.35,
                valueGbp: 3500,
              },
              { industry: "Industrials", allocationPct: 0.16, valueGbp: 1600 },
            ],
          },
        },
      });
    }
    if (path === "/indices/global-contribution")
      return route.fulfill({
        json: {
          acwiMove: 0.005,
          acwiLevel: 100,
          referenceDate: "2026-01-30",
          asOf: stamp,
          phase: "completed",
          weightsAsOf: "2026-01-29",
          weightsStale: false,
          pricesStale: false,
          state: "partial",
          residual: 0.001,
          markets: [
            { market: "jp", move: 0.01, notOpen: false },
            { market: "us", move: 0.012, notOpen: false },
          ],
          rows: [
            {
              market: "jp",
              indexId: "nikkei-225",
              weight: 0.05,
              move: 0.01,
              contribution: 0.0005,
              notOpen: false,
            },
          ],
        },
      });
    if (path.endsWith("/reading")) {
      const role = path.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      calls.push({ role, ...body });
      const evidence = (source: string, tool: string, selection = {}) => ({
        source,
        tool,
        arguments: {...body.context, snapshotId:body.snapshotId ?? runId, ...selection},
        evidenceId: "ev_synthetic",
      });
      const lines =
        role === "market-map"
          ? [
              {
                zh: "全球市场",
                en: "Global markets",
                evidence: evidence("market", "global_map"),
                variants: Object.fromEntries(
                  ["jp", "us"].map((m) => [
                    m,
                    {
                      zh:
                        m === "jp"
                          ? "日本对 MSCI ACWI 的估算贡献为 +0.05 个百分点。"
                          : "美国本地指数涨幅为 +1.20%。",
                      en:
                        m === "jp"
                          ? "Japan contributed an estimated +0.05 pp to MSCI ACWI."
                          : "The US index moved +1.20%.",
                      evidence: evidence("market", "global_map", {market:m}),
                    },
                  ]),
                ),
              },
            ]
          : role === "attribution" ? (() => {
            const data = backendFixture(new URL("/api/backend/dashboard/lens/analytics",url)) as DashboardLens;
            const {start,end,scope,view} = body.context;
            const account: Scope = scope === "broker_total" ? "total" : scope;
            const value = (date:string) => navNumber(data.nav?.find(p=>p.date===date),account,"Twr");
            const change = periodReturn(value(start),value(end));
            const formatted = new Intl.NumberFormat("en-GB",{style:"percent",minimumFractionDigits:2,maximumFractionDigits:2,signDisplay:"exceptZero"}).format(change ?? 0);
            return [
              change === null || view === "money" ?
                {zh:"区间端点已选定。",en:"The chart endpoints are selected.",evidence:evidence("account","selected_money")} :
                {zh:`组合在这段区间的时间加权收益为 ${formatted}。`,en:`Portfolio time-weighted return was ${formatted} over this range.`,evidence:evidence("account","selected_daily")},
              {zh:"区间内缺少可核实的持股汇率拆分。",en:"There is no verified held-share currency split for this range.",evidence:evidence("holdings","selected_fx")},
            ];
          })() : role === "exposure" && body.context.dimension === "company" ? (() => {
            const {lookthrough} = backendFixture(new URL("/api/backend/dashboard/lens/holdings-lookthrough",url)) as DashboardLens;
            const position = lookthrough?.positions.find(p=>p.entityId===body.context.entityId);
            if (position?.allocationPct == null) return [];
            const weight = (position.allocationPct * 100).toFixed(2) + "%";
            return [
              {zh:`组合权重为 ${weight}。`,en:`Portfolio weight was ${weight}.`,evidence:evidence("exposure","selected_exposure")},
              {zh:"缺少可比的历史记录。",en:"No comparable historical weight is available.",evidence:evidence("exposure","selected_exposure")},
            ];
          })() : notes[role as keyof typeof notes].map(([zh, en, word, tool]) => ({
              zh,
              en,
              evidence: evidence(word, tool, tool === "exposure_benchmark" ? {
                benchmarkSource: "SWDA", benchmarkAsOf: "2026-01-29", benchmarkObservation: "bw_1234567890abcdef",
              } : {}),
            }));
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({
            type: "result",
            reading: {
              role,
              version: runId,
              snapshotId: runId,
              asOf: stamp,
              lines,
            },
          }) + "\n",
      });
    }
    return route.fulfill({
      status: fixture === undefined ? 404 : 200,
      json: fixture ?? {},
    });
  });
  await page.route("**/api/logos/**", (route) => route.abort());
  return calls;
}

test.skip(
  !process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://127.0.0.1:"),
  "Use an isolated local build.",
);
for (const locale of ["en", "zh"] as const) {
  for (const dark of [false, true]) {
    test(`selections and map share scoped readings · ${locale} · ${dark ? "dark" : "light"}`, async ({
      page,
      isMobile,
    }) => {
      test.setTimeout(90_000);
      const calls = await setup(page, locale, dark);
      const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
      await page.setViewportSize(
        isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      const surface = page
        .locator(isMobile ? ".mx-reading-sheet" : ".mx-inline-reading")
        .last();
      const shots = process.env.TM_INSPECTION_SHOTS;
      async function capture(name: string, selector: string) {
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({
            path: join(
              shots,
              `${name}-${isMobile ? "phone" : "desktop"}-${locale}-${dark ? "dark" : "light"}.png`,
            ),
            animations: "disabled",
          });
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        expect(
          (await new AxeBuilder({ page }).include(selector).analyze())
            .violations,
        ).toEqual([]);
      }
      await page.goto("/holdings?view=lookthrough");
      await page
        .getByRole("tab", { name: t("板块", "Sectors"), exact: true })
        .click();
      const switches = page.getByRole("group", {
        name: t("配置图形", "Allocation chart"),
      });
      await switches
        .getByRole("button", {
          name: locale === "zh" ? "组成" : /^(Composition|Mix)$/,
        })
        .click();
      await page
        .getByRole("group", {
          name: t("选择配置分类", "Choose allocation category"),
        })
        .getByRole("button")
        .first()
        .click();
      await expect(surface).toContainText("SWDA");
      expect(calls.at(-1)).toMatchObject({
        role: "exposure",
        snapshotId: runId,
        context: { dimension: "sector", category: "Information Technology" },
      });
      await surface.scrollIntoViewIfNeeded();
      await capture(
        "holdings",
        isMobile ? ".mx-reading-sheet" : ".mx-inline-reading",
      );
      if (isMobile)
        await page
          .getByRole("button", { name: t("关闭解读", "Close reading") })
          .click();

      await page.goto("/analytics?view=returns&range=3M&benchmark=QQQ");
      const plot = page.locator("[data-tm-chart-ready=true]").first();
      await expect(plot).toBeVisible();
      if (isMobile)
        await page
          .getByRole("group", { name: t("绩效区间", "Performance range") })
          .getByRole("button", { name: "YTD", exact: true })
          .click();
      else {
        const b = (await plot.boundingBox())!;
        const x = b.x + b.width * 0.32,
          y = b.y + b.height * 0.23;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + b.width * 0.3, y, { steps: 6 });
        await page.mouse.up();
      }
      await expect(surface).toContainText(t("时间加权", "time-weighted"));
      expect(calls.at(-1)).toMatchObject({
        role: "attribution",
        context: { scope: "broker_total", benchmark: "QQQ" },
      });
      expect(calls.at(-1)!.context.start < calls.at(-1)!.context.end).toBe(
        true,
      );
      await surface.scrollIntoViewIfNeeded();
      await capture(
        "returns",
        isMobile ? ".mx-reading-sheet" : ".mx-inline-reading",
      );

      await page.goto("/sectors?market=us&sector=2");
      await expect(surface).toContainText(
        t("有报价的成分", "Among quoted constituents"),
      );
      expect(calls.at(-1)).toMatchObject({
        role: "market-sector",
        context: { market: "us", sector: "2" },
      });
      await surface.scrollIntoViewIfNeeded();
      await capture(
        "sector",
        isMobile ? ".mx-reading-sheet" : ".mx-inline-reading",
      );
      await page.goto("/sectors?market=global");
      const map = page.locator(".mx-global-region[data-market=jp]");
      await expect
        .poll(() => calls.filter((row) => row.role === "market-map").length)
        .toBe(1);
      if (isMobile) await map.tap();
      else await map.focus();
      await expect(page.locator(".mx-map-reading")).toContainText("MSCI ACWI");
      await capture("map", ".mx-global-inspection");
      const us = page.locator(".mx-global-region[data-market=us]");
      if (isMobile) await us.tap();
      else await us.focus();
      await expect(page.locator(".mx-map-reading")).toContainText("1.20%");
      expect(calls.filter((r) => r.role === "market-map")).toHaveLength(1);

      await page.goto("/health");
      await page
        .getByRole("button", { name: /为什么|Why/ })
        .first()
        .click();
      await expect(surface).toContainText("Pie");
      await expect(surface.locator(".mx-reading-line").last()).toContainText(
        t("推断", "Inference"),
      );
      await capture(
        "health",
        isMobile ? ".mx-reading-sheet" : ".mx-anchored-reading",
      );
      await surface.locator(".mx-reading-actions button").first().click();
      const composer = page.locator(".mx-assistant-composer textarea");
      await expect(composer).toHaveValue(
        t("哪些步骤已完成？", "Which steps completed?"),
      );
      const sent = page.waitForRequest((req) =>
        new URL(req.url()).pathname.endsWith("/assistant/chat"),
      );
      await composer.press("Enter");
      expect((await sent).postDataJSON().context).toMatchObject({
        page: "health",
        role: "diagnosis",
        snapshotId: runId,
        object: { issue: "job", job: "synthetic-failed" },
      });
    });
  }
}
test("off keeps the original page controls and sends no assistant requests", async ({
  page, isMobile,
}) => {
  const calls = await setup(page, "en", false, false);
  const requests: string[] = [];
  page.on("request", request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/backend/assistant/")) requests.push(pathname);
  });
  for (const url of [
    "/holdings?view=lookthrough",
    "/analytics?view=money",
    "/analytics?view=returns",
    "/analytics?view=risk",
    "/sectors?market=us&sector=2",
    "/sectors?market=global",
    "/health",
  ]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.locator(
        ".mx-why,.mx-inline-reading,.mx-reading-sheet,.mx-map-reading,.mx-range-inspect-mobile",
      ),
    ).toHaveCount(0);
    if (process.env.TM_INSPECTION_SHOTS && url === "/health") {
      await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS, (isMobile ? "phone" : "desktop") + "-disabled-health.png"), animations:"disabled"});
    }
  }
  expect(calls).toEqual([]);
  expect(requests).toEqual([]);
});

test("keyboard range survives a failed reading, stop and retry", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Keyboard brushing uses the desktop chart.");
  const calls = await setup(page, "en", false);
  let attempt = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assistant/roles/attribution/reading", async (route) => {
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        status: 503,
        json: { detail: { code: "provider_rate_limited" } },
      });
    if (attempt === 2) {
      await held;
      return route.abort().catch(() => undefined);
    }
    return route.fallback();
  });
  try {
    await page.goto("/analytics?view=returns&scope=invest&range=3M&benchmark=QQQ");
    const chart = page
      .locator('[aria-roledescription="Interactive chart"]')
      .first();
    await chart.focus();
    await chart.press("End");
    await page.keyboard.down("Shift");
    await chart.press("ArrowLeft");
    await chart.press("ArrowLeft");
    await page.keyboard.up("Shift");
    const card = page.locator(".mx-inline-reading").last();
    await expect(card).toContainText("Reading unavailable.");
    await expect(chart).toBeVisible();
    await card.getByRole("button", { name: "Retry" }).click();
    await card.getByRole("button", { name: "Stop" }).click();
    await expect(card).toContainText("Stopped.");
    release();
    await card.getByRole("button", { name: "Retry" }).click();
    await expect(card).toContainText("time-weighted");
    const selected = calls.find((c) => c.role === "attribution")!.context;
    await card.locator(".mx-reading-actions button").first().click();
    const composer = page.locator(".mx-assistant-composer textarea");
    await expect(composer).toHaveValue("Which day moved most?");
    const sent = page.waitForRequest((req) =>
      new URL(req.url()).pathname.endsWith("/assistant/chat"),
    );
    await composer.press("Enter");
    expect((await sent).postDataJSON().context).toMatchObject({
      page: "analytics",
      scope: "invest",
      role: "attribution",
      range: "3M",
      benchmark: "QQQ",
      snapshotId: runId,
      object: selected,
    });
  } finally {
    release();
  }
});

test("phone range opens the reading for the satisfying publication", async ({page, isMobile}) => {
  test.skip(!isMobile);
  const calls = await setup(page, "en", false);
  await page.route("**/dashboard/lens/analytics?**", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("range") !== "YTD") return route.fallback();
    return route.fulfill({ json: { ...(backendFixture(url) as object), runId: "revised" } });
  });
  await page.goto("/analytics?view=returns&range=3M&benchmark=QQQ");
  await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
  await page.getByRole("group",{name:"Performance range"}).getByRole("button",{name:"YTD",exact:true}).click();
  await expect(page.locator(".mx-reading-sheet")).toContainText("time-weighted");
  expect(calls.filter(c=>c.role==="attribution")).toMatchObject([{snapshotId:"revised",context:{range:"YTD",scope:"broker_total"}}]);
});

test("map card tabs back to the inspected market and forward to its neighbour", async ({page, isMobile}) => {
  test.skip(isMobile);
  const calls = await setup(page,"en",false);
  await page.goto("/sectors?market=global");
  await expect.poll(()=>calls.filter(c=>c.role==="market-map").length).toBe(1);
  const region = page.locator(".mx-global-region[data-market=jp]");
  await region.focus();
  const card = page.locator(".mx-global-inspection");
  await expect(card.locator(".mx-map-reading")).toContainText("MSCI ACWI");
  const controls = card.locator("button, a");
  await region.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(region).toBeFocused();
  await region.press("Tab");
  for (let i=0;i<await controls.count();i++){
    await expect(controls.nth(i)).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(page.locator(".mx-global-region[data-market=jp] + .mx-global-region")).toBeFocused();
});

test("an archived Money brush pins its plotted publication through handoff", async ({ page, isMobile }) => {
  test.skip(isMobile);
  const calls = await setup(page,"en",false);
  await page.route("**/dashboard/history?**",route=>{
    const url = new URL(route.request().url());
    return route.fulfill({json:{...backendFixture(url) as object, runId:url.searchParams.get("runId")}});
  });
  await page.goto("/analytics?view=money&range=1M&moneyFrom=2026-01-02&moneyTo=2026-01-30&snapshotId=older&evidence=period_performance");
  const chart = page.locator('[aria-roledescription="Interactive chart"]').first();
  await chart.focus();
  await chart.press("End");
  await chart.press("Shift+ArrowLeft");
  const card = page.locator(".mx-inline-reading").last();
  await expect(card).toContainText("chart endpoints");
  expect(calls.at(-1)?.snapshotId).toBe("older");
  await card.getByRole("button",{name:"Which day moved most?"}).click();
  const sent = page.waitForRequest(req=>req.url().includes("/assistant/chat"));
  await page.locator(".mx-assistant-composer textarea").press("Enter");
  expect((await sent).postDataJSON().context).toMatchObject({snapshotId:"older",role:"attribution",object:calls.at(-1)?.context});
});

test("sector follow-up waits for the pinned reading",async ({page})=>{
  await setup(page,"en",false);
  let release!:()=>void;
  const held = new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/assistant/roles/market-sector/reading",async route=>{await held;return route.fallback();});
  try {
    await page.goto("/sectors?market=us&sector=2");
    const question=page.getByRole("button",{name:"What is my exposure?"});
    await expect(question).toBeDisabled();
    release();
    await expect(question).toBeEnabled();
    await question.click();
    const sent=page.waitForRequest(req=>req.url().includes("/assistant/chat"));
    await page.locator(".mx-assistant-composer textarea").press("Enter");
    expect((await sent).postDataJSON().context).toMatchObject({snapshotId:runId,role:"market-sector",object:{market:"us",sector:"2",observed:stamp}});
  } finally {release();}
});

test("cited Returns and Holdings reopen their selection and disclose expiry",async ({page})=>{
  const calls=await setup(page,"en",false);
  let expired=false;
  await page.route("**/dashboard/lens/**",route=>{
    const url=new URL(route.request().url());
    if (url.searchParams.get("runId")!=="older") return route.fallback();
    return expired ? route.fulfill({status:404,json:{}}) : route.fulfill({json:{...backendFixture(url) as object,runId:"older"}});
  });
  for (const [url,role,selection] of [
    ["/analytics?view=returns&range=1M&inspectFrom=2026-01-06&inspectTo=2026-01-20&snapshotId=older&evidence=selected_daily","attribution",{start:"2026-01-06",end:"2026-01-20"}],
    ["/holdings?view=lookthrough&dimension=company&category=SYNT&entityId=SYNT&snapshotId=older&evidence=selected_exposure","exposure",{category:"SYNT",entityId:"SYNT"}],
  ] as const) {
    expired=false;
    await page.goto(url);
    await expect.poll(()=>calls.at(-1)).toMatchObject({role,snapshotId:"older",context:selection});
    expired=true;
    await page.reload();
    await expect(page.getByText("Cited publication unavailable",{exact:true})).toBeVisible();
  }
});

test("a Holdings benchmark citation reopens the dated fund observation", async ({page}) => {
  const calls = await setup(page, "en", false);
  await page.goto("/holdings?view=lookthrough&dimension=sector&category=Information%20Technology");
  const reading = page.locator(".mx-inline-reading:visible, .mx-reading-sheet:visible");
  const citation = reading.locator('a[href*="evidence=exposure_benchmark"]');
  await citation.click();
  await expect.poll(() => calls.at(-1)).toMatchObject({
    role: "exposure", snapshotId: runId,
    context: {dimension: "sector", category: "Information Technology", citedBenchmark: "SWDA",
      citedBenchmarkAsOf: "2026-01-29", citedBenchmarkObservation: "bw_1234567890abcdef"},
  });
});

test("a sector citation reopens the selected sector in its publication", async ({page}) => {
  const calls = await setup(page, "en", false);
  await page.goto("/sectors?market=us&sector=2");
  const link = page.locator(".mx-inline-reading:visible, .mx-reading-sheet:visible").getByRole("link", {name:"Market"}).first();
  await link.click();
  await expect.poll(() => calls.at(-1)).toMatchObject({
    role:"market-sector", snapshotId:runId, context:{market:"us",sector:"2",observed:stamp},
  });
  await expect(page.getByRole("button",{name:"What is my exposure?"})).toBeEnabled();
});

test("Japan market citation reopens its observed inspection and discloses a replaced board",async ({page,isMobile})=>{
  const calls = await setup(page,"en",false);
  await page.goto("/sectors?market=global");
  await expect.poll(()=>calls.filter(c=>c.role==="market-map").length).toBe(1);
  const japan = page.locator(".mx-global-region[data-market=jp]");
  await expect(japan).toHaveAttribute("aria-label", /Move /);
  if (isMobile) await japan.tap();
  else await japan.focus();
  const link = page.locator(".mx-map-reading").getByRole("link",{name:"Market"});
  const url = (await link.getAttribute("href"))!;
  expect(Object.fromEntries(new URL(url,"http://localhost").searchParams)).toMatchObject({region:"jp", observed:stamp, snapshotId:runId});
  await link.click();
  await expect(page).toHaveURL(new RegExp("region=jp"));
  await expect.poll(()=>calls.at(-1)).toMatchObject({role:"market-map",snapshotId:runId});
  await expect(page.locator(".mx-global-inspection")).toContainText("Japan");
  await expect(page.locator(".mx-map-reading")).toContainText("MSCI ACWI");
  // Re-enter the citation through browser history while the market board is still available.
  await page.goBack();
  await expect(page).toHaveURL(/sectors\?market=global$/);
  await page.route("**/assistant/roles/market-map/reading", route =>
    route.request().postDataJSON().snapshotId === runId
      ? route.fulfill({status:404,json:{detail:{code:"assistant_snapshot_missing"}}})
      : route.fallback());
  await page.goForward();
  await expect(page).toHaveURL(/region=jp/);
  await expect(page.getByText("Cited publication unavailable",{exact:true})).toBeVisible();
  await page.goto(url.replace(encodeURIComponent(stamp),"2025-01-01T00%3A00%3A00Z"));
  await expect(page.getByText("Cited market observation unavailable",{exact:true})).toBeVisible();
});

test("a new publication preserves the selected phone reading until explicitly updated", async ({page,isMobile})=>{
  test.skip(!isMobile);
  await page.setViewportSize({width:390,height:844});
  const calls=await setup(page,"en",false);
  let id=runId;
  await page.route("**/api/backend/health",route=>route.fulfill({json:{service:"trading_max-api",status:"ok",latestRunId:id}}));
  await page.route("**/dashboard/lens/analytics?**",route=>route.fulfill({json:{...backendFixture(new URL(route.request().url())) as object,runId:id}}));
  await page.clock.install();
  await Promise.all([page.waitForResponse(r=>r.url().endsWith("/assistant/status")),page.goto("/analytics?view=returns&range=3M")]);
  await expect(page.getByRole("heading",{name:"Return comparison",exact:true})).toBeAttached();
  await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
  await page.getByRole("button",{name:"YTD",exact:true}).click();
  const sheet=page.getByRole("dialog");
  await expect(sheet).toContainText("time-weighted");
  const context=calls.at(-1)!.context;
  id="new-publication";
  const changed=page.waitForResponse(r=>r.url().includes("/dashboard/lens/analytics?"));
  await page.clock.fastForward(65_000);
  await changed;
  await expect(sheet).toContainText("time-weighted");
  const updated = sheet.getByRole("button",{name:"Read updated records"});
  await expect(updated).toBeVisible();
  await expect(page.locator(".mantine-Tooltip-tooltip:has(.mx-tooltip-keys)")).not.toBeVisible();
  if (process.env.TM_INSPECTION_SHOTS) await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,"phone-reading-new-publication.png")});
  await updated.click();
  await expect.poll(()=>calls.at(-1)).toMatchObject({snapshotId:id,context});
});

test("company reading returns keyboard focus to the underlying detail", async ({page,isMobile})=>{
  test.skip(!isMobile);
  await page.setViewportSize({width:390,height:844});
  await setup(page,"en",false);
  await Promise.all([page.waitForResponse(r=>r.url().endsWith("/assistant/status")),page.goto("/holdings?view=lookthrough")]);
  const trigger = page.locator("[data-assistant-trigger]");
  await trigger.click();
  await expect(page.locator(".mx-assistant-opening")).toBeVisible();
  await page.getByRole("button",{name:"Close sidebar"}).click();
  await page.locator(".mx-holding-mobile").first().click();
  await expect(page.locator(".mx-reading-sheet")).toContainText("8.50%");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  const detail=page.getByRole("dialog",{name:"Underlying exposure"});
  await expect(detail).toBeVisible();
  await expect.poll(()=>detail.evaluate(node=>node.contains(document.activeElement))).toBe(true);
  if (process.env.TM_INSPECTION_SHOTS) await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,"phone-company-detail-focus.png")});
});

test("same-page Returns citations take precedence over a brush and follow browser history", async ({page,isMobile})=>{
  test.skip(isMobile, "Keyboard brushes are desktop controls.");
  const calls=await setup(page,"en",false);
  const first="/analytics?view=returns&range=1M&benchmark=QQQ&snapshotId="+runId+"&evidence=selected_daily&inspectFrom=2026-01-06&inspectTo=2026-01-20";
  const second=first.replace("01-06","01-05").replace("01-20","01-16");
  await page.goto(first);
  const chart=page.locator('[aria-roledescription="Interactive chart"]').first();
  const card=page.locator(".mx-inline-reading").last();
  await expect(card).toContainText("2026-01-06");
  await chart.focus();
  await chart.press("End");
  await chart.press("Shift+ArrowLeft");
  await expect(card).toContainText("2026-01-30");
  await page.evaluate(url=>history.pushState(null,"",url),second);
  await expect(card).toContainText("2026-01-05 – 2026-01-16");
  await expect.poll(()=>calls.at(-1)).toMatchObject({snapshotId:runId,context:{start:"2026-01-05",end:"2026-01-16"}});
  await page.goBack();
  await expect(card).toContainText("2026-01-06 – 2026-01-20");
  await page.goForward();
  await expect(card).toContainText("2026-01-05 – 2026-01-16");
});

for (const [view, singlePoint] of [["returns", false], ["money", false], ["risk", false], ["risk", true]] as const) {
test(`a missing endpoint in the updated phone ${view} reading restores ${singlePoint ? "the Risk tab with one point" : "its range control"}`, async ({page,isMobile})=>{
  test.skip(!isMobile);
  await page.setViewportSize({width:390,height:844});
  const calls=await setup(page,"en",false);
  let id=runId;
  await page.route("**/api/backend/health",route=>route.fulfill({json:{service:"trading_max-api",status:"ok",latestRunId:id}}));
  await page.route("**/dashboard/lens/analytics?**",route=>{
    const data=backendFixture(new URL(route.request().url())) as DashboardLens;
    const updatedNav = singlePoint ? data.nav?.slice(0,1) : data.nav?.slice(0,-1);
    return route.fulfill({json:{...data,runId:id,nav:id===runId?data.nav:updatedNav}});
  });
  if (view === "money") {
    await page.route("**/dashboard/history?**", route => {
      const url = new URL(route.request().url());
      const input = id === runId ? historyFixture : {...historyFixture, runId:id, dataRevision:id,
        nav:historyFixture.nav.slice(0,-1), intradayNav:historyFixture.intradayNav.slice(0,-1)};
      return route.fulfill({json:prepareHistory(input,{scope:"total",range:portfolioRange(url.searchParams.get("range"))}).chart});
    });
  }
  await page.clock.install();
  await Promise.all([page.waitForResponse(r=>r.url().endsWith("/assistant/status")),page.goto("/analytics?view="+view+"&range=3M")]);
  await expect(page.locator("[data-tm-chart-ready=true]").first()).toBeVisible();
  const trigger=page.getByRole("button",{name:view === "risk" ? "Read range" : "YTD",exact:true});
  await trigger.focus();
  await trigger.press("Enter");
  const sheet=page.getByRole("dialog");
  await expect(sheet).toContainText("currency split");
  id="new-publication";
  const changed=page.waitForResponse(r=>r.url().includes("/dashboard/lens/analytics?"));
  await page.clock.fastForward(65_000);
  await changed;
  await sheet.getByRole("button",{name:"Read updated records"}).click();
  await expect(sheet.getByRole("status")).toHaveText("Cited interval unavailable");
  await expect(sheet.getByRole("button",{name:"Close reading"})).toBeFocused();
  expect(calls.some(c=>c.snapshotId===id)).toBe(false);
  const shotName = "phone-"+view+(singlePoint ? "-one-point" : "");
  if (process.env.TM_INSPECTION_SHOTS) await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,shotName+"-updated-endpoint-unavailable.png")});
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  if (singlePoint) await expect(trigger).toHaveCount(0);
  await expect(singlePoint ? page.getByRole("tab", {name:"Risk profile", selected:true}) : trigger).toBeFocused();
  if (process.env.TM_INSPECTION_SHOTS) await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,shotName+"-dismissed-focus.png")});
});
}

for (const view of ["holdings","money","returns","risk"] as const) {
  test(`opens the cited ${view} using the retained dashboard API`, async ({page,request,isMobile})=>{
    const calls=await setup(page,"en",false);
    if (isMobile) await page.setViewportSize({width:390,height:844});
    // The assistant is synthetic; both dashboard routes go through the actual Next and API servers.
    await page.route("**/api/backend/dashboard/**",route=>route.continue());
    const publication = await request.get("/api/backend/dashboard/lens/analytics?scope=isa&detail=summary&range=ALL");
    expect(publication.ok()).toBe(true);
    const latest = await publication.json() as DashboardLens;
    const id = process.env.TM_RETAINED_QA_RUN ?? latest.runId;
    const scope = view==="money" ? "household" : "isa";
    const bad:string[]=[];
    page.on("response",r=>{if(r.url().includes("/dashboard/") && r.status()>=400) bad.push(String(r.status())+" "+r.url());});
    const q=new URLSearchParams({snapshotId:id,view,scope,range:"ALL",benchmark:"VOO",evidence:view==="holdings"?"selected_exposure":"selected_daily"});
    let path="/analytics";
    if(view==="holdings"){
      path="/holdings";
      q.set("view","lookthrough"); q.set("dimension","country"); q.set("category","US");
    }else{
      let dates:string[];
      if(view==="money"){
        const r=await request.get("/api/backend/dashboard/history?"+new URLSearchParams({runId:id,scope,range:"1M"}));
        expect(r.ok()).toBe(true);
        const {history}=await r.json();
        dates=history.points.map((p:{date:string})=>p.date);
        q.set("range","1M");q.set("evidence","selected_money");
      }else{
        const r=await request.get("/api/backend/dashboard/lens/analytics?"+new URLSearchParams({runId:id,scope,detail:"summary",range:"ALL"}));
        expect(r.ok()).toBe(true);
        const data=await r.json() as DashboardLens;
        const prices=new Set(data.benchmarkSeries?.VOO?.map(p=>p.date));
        dates=(data.nav??[]).filter(p=>p.isaTwr!=null && (view==="risk" || prices.has(p.date))).map(p=>p.date);
      }
      expect(dates.length).toBeGreaterThan(1);
      q.set("inspectFrom",dates.at(-2)!); q.set("inspectTo",dates.at(-1)!);
    }
    const response=page.waitForResponse(r=>{
      const url=new URL(r.url());
      return url.searchParams.get("runId")===id && url.pathname.endsWith(view==="holdings"?"/lens/holdings-lookthrough":view==="money"?"/dashboard/history":"/lens/analytics");
    });
    await page.goto(path+"?"+q);
    const pinned=await response;
    expect(pinned.status()).toBe(200);
    const data=await pinned.json();
    expect(data.runId).toBe(id);
    if(view==="risk") {
      const rows = data.nav as {date:string; isaDrawdown?:number; isaTwr?:number}[];
      const lowest = Math.min(...rows.flatMap(p=>p.isaDrawdown == null ? [] : [p.isaDrawdown]));
      const trough = rows.findIndex(p=>p.isaDrawdown === lowest);
      const peak = rows.slice(0,trough).filter(p=>p.isaTwr != null).sort((a,b)=>b.isaTwr!-a.isaTwr! || b.date.localeCompare(a.date))[0];
      expect(lowest).toBeLessThan(0);
      expect(peak).toBeDefined();
      const episode = page.locator(".mx-risk-drawdown-episode time");
      await expect(episode.first()).toHaveAttribute("datetime", peak.date);
      await expect(episode.last()).toHaveAttribute("datetime", rows[trough].date);
      if (!isMobile && process.env.TM_INSPECTION_SHOTS) {
        await page.locator(".mx-risk-readings").scrollIntoViewIfNeeded();
        await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS,"desktop-retained-isa-drawdown.png")});
      }
      expect(Object.keys(data.risk)).toEqual(["B"]);
      expect(data).not.toHaveProperty("benchmarkSeries");
    }
    if(view==="holdings") expect(data.lookthrough.countryAllocation.length).toBeGreaterThan(0);
    await expect.poll(()=>calls.at(-1)).toMatchObject({role:view==="holdings"?"exposure":"attribution",snapshotId:id});
    if (process.env.TM_INSPECTION_SHOTS) {
      const reading = page.locator(isMobile ? ".mx-reading-sheet:visible" : ".mx-inline-reading:visible").last();
      const firstLine = reading.locator(".mx-reading-line").first();
      await expect(firstLine).toBeVisible();
      if (!isMobile) await firstLine.scrollIntoViewIfNeeded();
      await page.screenshot({path:join(process.env.TM_INSPECTION_SHOTS, (isMobile ? "phone" : "desktop") + "-retained-" + view + ".png"), animations:"disabled"});
    }
    if (view === "money") {
      if (isMobile) {
        q.set("evidence", "period_performance");
        q.set("moneyFrom", q.get("inspectFrom")!.slice(0,10));
        q.set("moneyTo", q.get("inspectTo")!.slice(0,10));
        q.delete("inspectFrom");
        q.delete("inspectTo");
        await page.goto(path+"?"+q);
      }
      const exact = page.waitForRequest(r => new URL(r.url()).searchParams.has("page") && r.url().includes("/dashboard/history?"));
      await page.getByText("View exact observations",{exact:true}).first().click();
      const params = new URL((await exact).url()).searchParams;
      expect(params.get("runId")).toBe(id);
      expect(params.get("retained")).toBe("1");
    }
    expect(bad).toEqual([]);
  });
}
