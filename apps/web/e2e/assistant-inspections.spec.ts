import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { backendFixture } from "../tests/loading/fixtures";

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
  attribution: [
    [
      "组合在这段区间的时间加权收益为 +1.30%。",
      "Portfolio time-weighted return was +1.30% over this range.",
      "account",
      "daily_returns",
    ],
    [
      "区间内缺少可核实的持股汇率拆分。",
      "There is no verified held-share currency split for this range.",
      "holdings",
      "holding_fx_split",
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
      const evidence = (source: string, tool: string) => ({
        source,
        tool,
        arguments: body.context,
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
                      evidence: evidence("market", "global_map"),
                    },
                  ]),
                ),
              },
            ]
          : notes[role as keyof typeof notes].map(([zh, en, word, tool]) => ({
              zh,
              en,
              evidence: evidence(word, tool),
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
        req.url().endsWith("/assistant/chat"),
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
test("off leaves the original page controls and sends no role requests", async ({
  page,
}) => {
  const calls = await setup(page, "en", false, false);
  for (const url of [
    "/holdings?view=lookthrough",
    "/analytics?view=returns",
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
  }
  expect(calls).toEqual([]);
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
      req.url().endsWith("/assistant/chat"),
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
