import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe("data status and scheduled updates", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a local preview.");

  test("a dated published snapshot can coexist with an empty job log", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const queue = { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0 };
    const worker = { healthy: true };
    await page.route("**/api/backend/health/details", (route) => route.fulfill({ json: {
      checkedAt: "2026-11-15T00:00:00Z",
      health: { status: "ok", latestRunId: "synthetic-existing-snapshot", worker, queue, artifactAgeSeconds: 432_000 },
      readiness: { status: "ready", latestRunId: "synthetic-existing-snapshot", worker, queue },
      refresh: {}, jobs: [], errors: [],
    } }));
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: /no completed update for 5d/ })).toBeVisible();
    await expect(page.locator(".mx-health-page > [role=status][aria-live]")).toContainText("no completed update for 5d");
    await expect(page.locator(".mx-health-hero").getByText("Published snapshot", { exact: false })).toBeVisible();
    await expect(page.getByText("No update jobs recorded")).toBeVisible();
    await expect(page.getByText("Your first update starts here")).toHaveCount(0);
    await page.getByText("What each schedule updates", { exact: true }).click();
    await expect(page.getByText(/calculate returns, drawdowns and risk from reconciled account history/)).toBeVisible();
    await page.getByRole("link", { name: "Manage schedule" }).click();
    await expect(page.getByRole("link", { name: "See the schedule and update history" })).toBeVisible();
    await expect(page.getByText(/calculate returns, drawdowns and risk from reconciled account history/)).toHaveCount(0);
  });

  test("a delayed or timed-out research directory still names the requested listing", async ({ page, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/api/backend/research/shell", async (route) => {
      await gate;
      await route.fulfill({ status: 504, json: {} });
    });
    await page.goto("/research?ticker=SYNTH");
    await expect(page.getByRole("heading", { name: "SYNTH", exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("heading", { name: "Data request timed out" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "SYNTH", exact: true })).toBeVisible();
  });

  test("the first Data Status failure is announced without moving focus", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route(healthRoute, async (route) => {
      await gate;
      await route.fulfill({ status: 503, json: {} });
    });
    await page.goto("/health");
    const checkNow = page.getByRole("button", { name: "Check now" });
    await checkNow.focus();
    release();
    await expect(page.getByRole("heading", { name: "Data is temporarily unavailable" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Data is temporarily unavailable" })).toHaveCount(1);
    await expect(checkNow).toBeFocused();
  });

  test("a failed CFD review outside the history list stays visible until its retry succeeds", async ({ page }) => {
    const failed = { ...failedJob, scope: "cfd", trigger: "on_demand", error: "Synthetic CFD review failure" };
    const completed = { ...failed, jobId: "retry", createdAt: "2026-11-18T07:59:00Z", status: "succeeded", error: null };
    const jobs = Array.from({ length: 12 }, (_, index) => ({
      ...completed, jobId: `live-${index}`, scope: "live", trigger: "live",
    }));
    let latestTerminalJobs = [failed, jobs[0]];
    await mockHealth(page, () => ({ ...healthFixture({ jobs }), latestTerminalJobs }));
    await page.goto("/health");

    await expect(page.getByRole("heading", { name: "The data service needs attention" })).toBeVisible();
    await expect(page.locator(".mx-health-hero").getByText("Published snapshot", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Next scheduled updates" })).toBeVisible();
    await expect(page.getByText("Account data service")).toHaveCount(0);
    await expect(page.getByText("Scopes needing attention: CFD review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View issue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Update task details" });
    await dialog.locator("summary").filter({ hasText: "Technical details" }).press("Enter");
    await expect(dialog.locator("code")).toHaveText(failed.error);
    await expect(dialog.locator("code")).toBeVisible();
    await expect(dialog.getByText(/No stage details were recorded/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View issue", exact: true })).toBeFocused();

    latestTerminalJobs = [completed, jobs[0]];
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your data service is ready" })).toBeVisible();
    await expect(page.getByRole("button", { name: "View issue", exact: true })).toHaveCount(0);
  });

  test("missing schedule and history keep snapshot age, queue counts, and seven-day outcomes", async ({ page }) => {
    let probesDown = true;
    await mockHealth(page, () => {
      const payload = healthFixture();
      const queue = { ...payload.health.queue, queued: 2 };
      return {
        ...payload,
        health: { ...payload.health, artifactAgeSeconds: 432_000, queue, worker: { healthy: false } },
        refresh: probesDown ? null : { performance: { enabled: false, nextRunAt: null } },
        outcomes: { totals: { succeeded: 2 }, causes: [] },
        errors: probesDown ? [
          { scope: "refresh", status: 503, detail: "refresh probe unavailable" },
          { scope: "jobs", status: 503, detail: "jobs probe unavailable" },
        ] : [],
      };
    });

    await page.goto("/health");
    await expect(page.getByRole("heading", { name: "The data service needs attention" })).toBeVisible();
    await expect(page.getByText("The last published snapshot is 5d old.", { exact: true })).toBeVisible();
    const schedule = page.locator("section.mx-panel").filter({
      has: page.getByRole("heading", { name: "Next scheduled updates" }),
    });
    const history = page.locator("section.mx-panel").filter({
      has: page.getByRole("heading", { name: "Update history" }),
    });
    await expect(schedule.getByText("Scheduled updates are temporarily unavailable.", { exact: true })).toBeVisible();
    await expect(history.getByText("Update history is temporarily unavailable.", { exact: true })).toBeVisible();
    await expect(history.getByText("No update jobs recorded")).toHaveCount(0);
    await expect(history.getByLabel("Filter task status")).toHaveCount(0);
    await expect(history.locator(".mx-metric").filter({
      hasText: "In queue",
    }).getByText("2", { exact: true })).toBeVisible();
    await expect(history.getByText("All 2 updates in the last 7 days succeeded")).toBeVisible();
    await expect(page.getByRole("button", { name: /Recheck (schedule|history|status)/ })).toHaveCount(0);
    await expect(schedule.locator("code")).toHaveCount(2);
    await expect(schedule.locator("code").first()).toBeHidden();
    const diagnostics = schedule.locator("summary").filter({ hasText: "Runtime diagnostics" });
    await diagnostics.press("Enter");
    await expect(schedule.locator("code").first()).toBeVisible();
    await expect(schedule.getByText("refresh · 503", { exact: true })).toBeVisible();
    await diagnostics.press("Space");
    await expect(schedule.locator("code").first()).toBeHidden();

    probesDown = false;
    const checkNow = page.getByRole("button", { name: "Check now", exact: true });
    await checkNow.press("Enter");
    await expect(history.getByText("No update jobs recorded")).toBeVisible();
    await expect(checkNow).toBeFocused();
    const performance = schedule.locator("dl > div").filter({ has: page.getByText("Performance", { exact: true }) });
    await expect(performance.locator("dd")).toHaveText("Disabled");
  });

  for (const path of ["/health", "/desktop/activity"]) {
    test(`polling and a keyboard check preserve focus on ${path}`, async ({ page }) => {
      await page.clock.install();
      let requests = 0;
      let failed = false;
      let newsFailed = false;
      let gate: Promise<void> | undefined;
      await mockHealth(page, async () => {
        const poll = requests++;
        await gate;
        const payload = healthFixture({ jobs: failed ? [failedJob] : [] });
        return {
          ...payload,
          health: {
            ...payload.health,
            artifactAgeSeconds: 60 + poll * 5,
            eventRefreshes: newsFailed ? [{ kind: "news", failedSources: 1, failures: [{ source: "Fixture news" }] }] : [],
          },
        };
      });
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Your data service is ready" })).toBeVisible();

      const announcer = page.locator(".sr-only[role=status][aria-live=polite]");
      const checkNow = page.getByRole("button", { name: "Check now", exact: true });
      await expect(announcer).toHaveText("");
      await checkNow.focus();
      const auto = Promise.withResolvers<void>();
      gate = auto.promise;
      const beforePoll = requests;
      const response = page.waitForResponse(healthRoute);
      await page.clock.fastForward(5_100);
      expect(requests).toBe(beforePoll);
      await page.clock.fastForward(25_000);
      await expect.poll(() => requests).toBe(beforePoll + 1);
      await expect(checkNow).toBeEnabled();
      await expect(checkNow).not.toHaveAttribute("aria-busy");
      await expect(checkNow).toBeFocused();
      auto.resolve();
      await response;
      await expect(announcer).toHaveText("");

      failed = true;
      await page.clock.fastForward(30_100);
      await expect(announcer).toContainText("The data service needs attention");
      await expect(announcer).toContainText("Performance");
      await expect(checkNow).toBeFocused();

      const manual = Promise.withResolvers<void>();
      gate = manual.promise;
      const beforeManual = requests;
      await page.keyboard.press("Enter");
      await expect.poll(() => requests).toBe(beforeManual + 1);
      const checking = page.getByRole("button", { name: "Checking…", exact: true });
      await expect(checking).toHaveAttribute("aria-disabled", "true");
      await expect(checking).toHaveAttribute("aria-busy", "true");
      await expect(checking).toBeFocused();
      await page.keyboard.press("Enter");
      expect(requests).toBe(beforeManual + 1);

      manual.resolve();
      await expect(checkNow).toBeEnabled();
      await expect(checkNow).not.toHaveAttribute("aria-busy");
      await expect(announcer).toContainText("Check complete:");
      await expect(checkNow).toBeFocused();

      // An additional source failure changes the announcement even while the headline is degraded.
      newsFailed = true;
      await page.clock.fastForward(30_100);
      await expect(announcer).toContainText("Security news · 1 source refresh failed · Fixture news");
      await expect(checkNow).toBeFocused();
    });
  }

  test("long job and stage diagnostics wrap at 320 px and double in size with text scaling", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const jobError = "Synthetic research mismatch: " + "x".repeat(260);
    const stageError = "unbroken_stage_" + "y".repeat(260);
    await mockHealth(page, () => healthFixture({
      jobs: [{
        ...failedJob,
        error: jobError,
        stages: [{
          name: "accounts.performance",
          status: "failed",
          startedAt: failedJob.startedAt,
          finishedAt: failedJob.finishedAt,
          error: stageError,
        }],
      }],
    }));

    await page.goto("/health");
    await page.getByRole("button", { name: "View issue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Update task details" });
    const disclosures = dialog.locator("summary").filter({ hasText: "Technical details" });
    await disclosures.nth(0).press("Enter");
    await disclosures.nth(1).press("Space");
    const diagnostics = dialog.locator("code");
    await expect(diagnostics).toHaveText([jobError, stageError]);
    const fonts = () => diagnostics.evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
    const overflow = () => dialog.evaluate((el) => el.scrollWidth > el.clientWidth ||
      [...el.querySelectorAll("code")].some((code) => code.scrollWidth > code.clientWidth));
    const originalFonts = await fonts();
    expect(await overflow()).toBe(false);
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))));
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(await fonts()).toEqual(originalFonts.map((size) => size * 2));
    expect(await overflow()).toBe(false);
  });

  test("expanded seven-day outcome wraps at 320 px with 200% text scaling", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const lastMessage = "unbroken_outcome_" + "z".repeat(260);
    await mockHealth(page, () => ({
      ...healthFixture(),
      outcomes: { totals: { failed: 1 }, causes: [{ scope: "performance", count: 1, lastMessage }] },
    }));
    await page.goto("/health");

    const outcomes = page.getByRole("region", { name: "Failures in the last 7 days" });
    await outcomes.getByText("Technical details", { exact: true }).click();
    const diagnostic = outcomes.locator("code");
    await expect(diagnostic).toHaveText(lastMessage);
    await expect(diagnostic).toBeVisible();
    const font = () => diagnostic.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const originalFont = await font();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await font()).toBe(originalFont * 2);
    expect(await diagnostic.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await outcomes.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });

  test("task links resolve older records and explain when a record is unavailable", async ({ page }) => {
    await mockHealth(page, () => healthFixture());
    const taskRoute = "**/api/backend/health/task?job=*";
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route(taskRoute, async (route) => {
      await gate;
      if (new URL(route.request().url()).searchParams.get("job") !== "old-performance") {
        return route.fulfill({ status: 404, json: {} });
      }
      await route.fulfill({ json: { ...failedJob, jobId: "old-performance" } });
    });

    await page.goto("/health?job=old-performance");
    const dialog = page.getByRole("dialog", { name: "Update task details" });
    await expect(dialog.locator(".mx-loading-message")).toHaveText("Loading data…");
    release();
    await expect(dialog.getByRole("heading", { name: "Performance" })).toBeVisible();
    await expect(dialog.getByText("No stage details were recorded.", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Check now" })).toBeFocused();

    await page.goto("/health?job=missing-performance");
    await expect(dialog.locator("[data-cited-missing]")).toHaveText("Cited update task unavailable");
    await expect(dialog.getByRole("heading", { name: "Performance" })).toHaveCount(0);
  });

  test("a delayed missing task is announced inside the sheet without moving focus", async ({ page }) => {
    await mockHealth(page, () => healthFixture());
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/api/backend/health/task?job=missing-performance", async (route) => {
      await gate;
      await route.fulfill({ status: 404, json: {} });
    });

    await page.goto("/health?job=missing-performance");
    const dialog = page.getByRole("dialog", { name: "Update task details" });
    const status = dialog.locator('[role="status"][aria-atomic="true"]');
    const close = dialog.getByRole("button", { name: "Close task details" });
    await expect(dialog.locator(".mx-loading-message")).toHaveText("Loading data…");
    await expect(status).toHaveText("");
    await close.focus();
    release();

    await expect(dialog.locator("[data-cited-missing]")).toHaveText("Cited update task unavailable");
    await expect(status).toHaveText("Cited update task unavailable");
    await expect(close).toBeFocused();
    await expect(dialog).toBeVisible();
  });

  test("Check now refreshes seven-day totals before announcing completion", async ({ page }) => {
    await page.clock.install();
    await mockHealth(page, () => ({ ...healthFixture(), outcomes: undefined }));
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let total = 2;
    await page.route("**/api/backend/health/outcomes", async (route) => {
      if (total === 3) await gate;
      await route.fulfill({ json: { totals: { succeeded: total }, causes: [] } });
    });

    await page.goto("/health");
    await expect(page.getByText("All 2 updates in the last 7 days succeeded")).toBeVisible();
    total = 3;
    const refreshing = page.waitForRequest("**/api/backend/health/outcomes", { timeout: 4000 });
    await page.getByRole("button", { name: "Check now", exact: true }).press("Enter");
    await refreshing;
    const status = page.locator(".mx-health-page > [role=status][aria-live]");
    await expect(status).toHaveText("Checking data status…");
    release();
    await expect(page.getByText("All 3 updates in the last 7 days succeeded")).toBeVisible();
    await expect(status).toContainText("Check complete:");
  });

  test("Check now announces an outcomes outage and keeps the last totals until recovery", async ({ page }) => {
    await mockHealth(page, () => ({ ...healthFixture(), outcomes: undefined }));
    let failing = false;
    let total = 2;
    await page.route("**/api/backend/health/outcomes", (route) => route.fulfill(failing
      ? { status: 503, json: { detail: "Update outcomes unavailable" } }
      : { json: { totals: { succeeded: total }, causes: [] } }));

    await page.goto("/health");
    const previous = page.getByText("All 2 updates in the last 7 days succeeded");
    await expect(previous).toBeVisible();
    failing = true;
    const check = page.getByRole("button", { name: "Check now", exact: true });
    const status = page.locator(".mx-health-page > [role=status][aria-live]");
    await check.press("Enter");
    await expect(status).toHaveText("Check failed: The seven-day update summary could not be checked.");
    await expect(previous).toBeVisible();
    await expect(check).toBeFocused();

    failing = false;
    total = 3;
    await check.press("Enter");
    await expect(page.getByText("All 3 updates in the last 7 days succeeded")).toBeVisible();
    await expect(status).toContainText("Check complete:");
  });

  test("history keyboard filtering and scope selection preserve update actions", async ({ page }) => {
    const routine = {
      ...failedJob, status: "succeeded", scope: "live", trigger: "live", error: null,
    };
    const queued = {
      ...failedJob, jobId: "enqueued", trigger: "on_demand", status: "queued", error: null, startedAt: null, finishedAt: null,
    };
    let started = false;
    await mockHealth(page, () => {
      const fixture = healthFixture({ jobs: started ? [queued] : [
        failedJob,
        { ...routine, jobId: "live-new" },
        { ...routine, jobId: "live-old", createdAt: "2026-11-18T07:54:00Z" },
      ] });
      if (started) fixture.health.queue.queued = 1;
      return fixture;
    });
    await page.route("**/api/backend/refresh", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ scope: "performance", skipSync: false, tickers: [] });
      started = true;
      await route.fulfill({ status: 202, json: queued });
    });

    await page.goto("/health");
    const rows = page.locator(".mx-job-row");
    await expect(rows).toHaveCount(2);
    const expand = page.getByRole("button", { name: "Show every update" });
    await expand.press("Space");
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: "Combine repeated successes" }).press("Enter");
    await expect(rows).toHaveCount(2);

    const filter = page.getByRole("combobox", { name: "Filter task status" });
    await filter.press("ArrowDown");
    await page.getByRole("option", { name: "Failed", exact: true }).click();
    await expect(filter).toHaveAttribute("aria-expanded", "false");
    await expect(rows).toHaveCount(1);
    await rows.first().press("Enter");
    const dialog = page.getByRole("dialog", { name: "Update task details" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Prepare another update with this scope" }).press("Enter");
    await expect(dialog).toHaveCount(0);
    const scope = page.getByRole("combobox", { name: "Update scope" });
    await expect(scope).toHaveText("Performance");
    await scope.press("ArrowDown");
    await expect(page.getByRole("listbox", { name: "Update scope" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scope).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Start update" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(scope).toBeFocused();

    await page.getByRole("button", { name: "Start update" }).press("Enter");
    await expect(dialog.getByRole("progressbar", { name: "Update stage progress" })).toBeAttached();
    await expect(dialog.getByText("The task is queued.", { exact: false })).toBeVisible();
  });
});

const healthRoute = "**/api/backend/health/details";
test("a failed health poll discloses interruption beside retained task stages", async ({ page }) => {
  await page.clock.install();
  let failing = false;
  const job = { ...failedJob, stages: [{ name: "publish", status: "failed", error: "Synthetic failure" }] };
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.route(healthRoute, (route) => route.fulfill(failing
    ? { status: 503, json: {} } : { json: healthFixture({ jobs: [job] }) }));
  await page.goto("/health?job=perf-fail");
  const dialog = page.getByRole("dialog", { name: "Update task details" });
  await expect(dialog.locator(".mx-stage-list > li")).toHaveCount(1);
  await expect(dialog.getByRole("note").filter({ hasText: "Data is temporarily unavailable" })).toHaveCount(0);
  failing = true;
  await page.clock.runFor(32_000);
  await expect(dialog.getByRole("note").filter({ hasText: "Data is temporarily unavailable" })).toBeVisible();
  await expect(dialog.locator(".mx-stage-list > li")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Update history" })).toBeVisible();
  await expect(page.getByText("Last successful check", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toBeFocused();
  failing = false;
  await page.keyboard.press("Enter");
  await expect(page.getByText("Last successful check", { exact: false })).toHaveCount(0);
});

const failedJob = {
  jobId: "perf-fail",
  scope: "performance",
  trigger: "performance",
  skipSync: true,
  status: "failed",
  createdAt: "2026-11-18T07:55:00Z",
  startedAt: "2026-11-18T07:55:01Z",
  finishedAt: "2026-11-18T07:55:10Z",
  snapshotRunId: null,
  error: "Synthetic performance timeout",
  stages: [] as object[],
};

function healthFixture(overrides: { jobs?: object[] } = {}) {
  const queue = { queued: 0, running: 0, succeeded: 2, failed: 0, interrupted: 0, last_success_at: "2026-11-18T07:55:00Z" };
  const worker = { healthy: true };
  return {
    checkedAt: "2026-11-18T08:00:00Z",
    health: { status: "ok", latestRunId: "synthetic-run", worker, queue, artifactAgeSeconds: 60 },
    readiness: { status: "ready", latestRunId: "synthetic-run", worker, queue },
    refresh: {},
    outcomes: null,
    jobs: [],
    errors: [],
    ...overrides,
  };
}

async function mockHealth(page: Page, getFixture: () => object | Promise<object>) {
  await page.addInitScript(() => localStorage.setItem("trading_max-locale", "en"));
  await page.route(healthRoute, async (route) => route.fulfill({ json: await getFixture() }));
}
